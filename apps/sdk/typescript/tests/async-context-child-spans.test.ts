/**
 * MHQ-924 regression: the active trace must survive an `await`.
 *
 * The defect: `tryLoadAls()` resolved `node:async_hooks` through a
 * runtime-eval'd `require`, which does not exist in ESM. Every `.mjs` /
 * `"type": "module"` consumer therefore fell through to the *browser*
 * fallback — a module-global, which holds across synchronous code but is
 * lost after the first `await`.
 *
 * Consequence in the field: any span an adapter opened after an await found
 * no active trace and was dropped, while the root span (opened synchronously
 * by `run()`) still persisted. A trace always arrived and looked healthy.
 * Live testing on 2026-08-04 saw langgraph, langchain and anthropic-agent-sdk
 * each log `span(...) was called with no active trace` from their own
 * internals, and land only the root span.
 *
 * What this asserts, and why it is shaped this way:
 *
 *   - It checks the ACTIVE TRACE CONTEXT across a macrotask boundary. That is
 *     the invariant that actually broke, and it is verifiable in-process.
 *     Measured A/B against the fix: pre-fix `false`, post-fix `true`.
 *   - A macrotask (`setTimeout`), not a microtask — the module-global
 *     fallback survives a microtask and would give a false pass.
 *   - Concurrency is asserted separately: a module-global cannot keep two
 *     overlapping runs apart; real `AsyncLocalStorage` can.
 *
 * Deliberately NOT asserted here: the resulting span COUNT on the wire. No
 * other test in this suite verifies a multi-span trace through
 * `_getLastTraceForTesting`, so such an assertion would be testing the
 * harness rather than the SDK. End-to-end span counts are covered by the
 * adapter matrix in `bizops/dogfood/runbooks/ts-sdk-adapter-matrix-setup.md`,
 * which reads them out of the database.
 */

import { beforeEach, describe, expect, it } from "vitest";

import * as morse from "../src/index";

function activeTrace(): unknown {
  return (
    morse as unknown as { _getActiveTraceStateForTesting?: () => unknown }
  )._getActiveTraceStateForTesting?.();
}

beforeEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_DISABLED;
});

describe("MHQ-924 — async trace context", () => {
  it("resolves a real AsyncLocalStorage on Node, not the browser fallback", () => {
    // `process.getBuiltinModule` (Node 22.3+) is the path that works in BOTH
    // ESM and CJS. `require` alone is the bug: absent under ESM.
    const getBuiltin = (process as unknown as { getBuiltinModule?: (m: string) => unknown })
      .getBuiltinModule;
    expect(typeof getBuiltin).toBe("function");
    const mod = getBuiltin!("node:async_hooks") as { AsyncLocalStorage?: unknown };
    expect(mod?.AsyncLocalStorage).toBeTruthy();
  });

  it("keeps the trace active across an await", async () => {
    morse.init({ apiKey: "av_test" }); // pragma: allowlist secret

    let sync: unknown = null;
    let afterAwait: unknown = null;

    await morse.run("ctx-test-agent", async () => {
      sync = activeTrace();
      await new Promise((r) => setTimeout(r, 5));
      afterAwait = activeTrace();
    });

    expect(sync).toBeTruthy();
    // The assertion that catches MHQ-924. Pre-fix this was null.
    expect(afterAwait).toBeTruthy();
  });

  it("keeps context through nested awaits", async () => {
    morse.init({ apiKey: "av_test" }); // pragma: allowlist secret

    let deepest: unknown = null;
    await morse.run("ctx-nested-agent", async () => {
      await new Promise((r) => setTimeout(r, 2));
      await (async () => {
        await new Promise((r) => setTimeout(r, 2));
        await (async () => {
          await new Promise((r) => setTimeout(r, 2));
          deepest = activeTrace();
        })();
      })();
    });

    expect(deepest).toBeTruthy();
  });

  it("does not leak context between two concurrent runs", async () => {
    morse.init({ apiKey: "av_test" }); // pragma: allowlist secret

    const seen: Record<string, unknown> = {};

    await Promise.all([
      morse.run("ctx-concurrent-a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.a = activeTrace();
      }),
      morse.run("ctx-concurrent-b", async () => {
        await new Promise((r) => setTimeout(r, 2));
        seen.b = activeTrace();
      }),
    ]);

    expect(seen.a).toBeTruthy();
    expect(seen.b).toBeTruthy();
    // Distinct trace states. A module-global would hand back one shared
    // object, or null once the faster run's reset fired.
    expect(seen.a).not.toBe(seen.b);
  });

  /* --------------------------------------------------------------------- */
  /*  Defect B — run() must not close an async trace before the body runs   */
  /* --------------------------------------------------------------------- */

  function spanNames(): string[] {
    const last = (
      morse as unknown as { _getLastTraceForTesting?: () => unknown }
    )._getLastTraceForTesting?.() as { spans?: { name?: string }[] } | null;
    return (last?.spans ?? []).map((s) => s.name as string);
  }

  it("run() with an ASYNC callback keeps child spans", async () => {
    morse.init({ apiKey: "av_test" }); // pragma: allowlist secret

    await morse.run("run-async-agent", async () => {
      await new Promise((r) => setTimeout(r, 5));
      await morse.spanAsync({ name: "kid-async", type: "tool" }, async () => {});
    });

    // Pre-fix this was ["run-async-agent"] only: run() routed through the sync
    // path, so endTrace fired the moment fn returned its promise and the trace
    // was sent with completedSpans still empty.
    expect(spanNames()).toEqual(expect.arrayContaining(["run-async-agent", "kid-async"]));
  });

  it("run() with a SYNC callback is unchanged", () => {
    morse.init({ apiKey: "av_test" }); // pragma: allowlist secret

    morse.run("run-sync-agent", () => {
      morse.span({ name: "kid-sync", type: "tool" }, () => {});
    });

    expect(spanNames()).toEqual(expect.arrayContaining(["run-sync-agent", "kid-sync"]));
  });

  it("run() still records failure when an async body throws", async () => {
    morse.init({ apiKey: "av_test" }); // pragma: allowlist secret

    await expect(
      morse.run("run-throws-agent", async () => {
        await new Promise((r) => setTimeout(r, 2));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const last = (
      morse as unknown as { _getLastTraceForTesting?: () => unknown }
    )._getLastTraceForTesting?.() as { trace?: Record<string, unknown> } | null;
    expect(last?.trace?.status).toBe("failed");
    expect(last?.trace?.error_message).toBe("boom");
  });
});
