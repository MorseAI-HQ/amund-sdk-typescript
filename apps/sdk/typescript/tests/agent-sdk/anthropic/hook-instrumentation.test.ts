/**
 * Tests for `anthropic-agent-sdk/hook-instrumentation.ts` (W2-A.4).
 *
 * Drives the `FakeClaudeSDKClient` (which has a `client.on("hook", ...)`
 * surface) and asserts that emitted hook spans:
 *
 *   - carry `metadata.tool_kind="hook"` and `metadata.hook.{name,kind}`
 *   - propagate `duration_ms` into `metadata.hook.duration_ms`
 *   - attach as siblings of a known tool span when `toolSpanLookup` resolves
 *   - fall back to top-of-stack parent when no lookup / no match
 *   - stop emitting after the returned unsubscribe is called
 *
 * Trace state is established via `runAsync` so `startSpan` has somewhere to
 * push the spans. Inspection uses `getLastTrace()` for completed spans and
 * `inspectTraceState()` for in-flight assertions.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { installHookInstrumentation } from "../../../src/anthropic-agent-sdk/hook-instrumentation";
import { inspectTraceState } from "../../../src/_agent-sdk-common/context-propagation";
import {
  _resetForTesting,
  getLastTrace,
  runAsync,
  startSpan,
} from "../../../src/_internal/tracing";
import { FakeClaudeSDKClient } from "./fixtures/fake-claude-agent-sdk";

interface WireSpan {
  span_id: string;
  parent_span_id?: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown> & {
    tool_kind?: string;
    hook?: { name?: string; kind?: string; duration_ms?: number };
  };
  duration_ms?: number;
}

/**
 * Collect every non-root span emitted while `inside()` runs inside a fresh
 * trace. Drains the iterator returned by `client.query()` when one is
 * provided so the fake fires its hook callbacks.
 */
async function collectSpans(inside: () => Promise<void>): Promise<WireSpan[]> {
  await runAsync({ agentName: "test-agent" }, async () => {
    await inside();
  });
  const last = getLastTrace();
  if (last === null) return [];
  return (last.spans as WireSpan[]).filter((s) => s.name !== "test-agent");
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Installer guardrails                                                     */
/* ------------------------------------------------------------------------ */

describe("installHookInstrumentation — installer guardrails", () => {
  it("returns a no-op unsubscriber when client.on is not a function", () => {
    const fakeClient = { query: async function* () {} } as unknown as Parameters<
      typeof installHookInstrumentation
    >[0];
    const unsub = installHookInstrumentation(fakeClient);
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });

  it("does not throw when client is missing required surface entirely", () => {
    const fakeClient = {} as unknown as Parameters<typeof installHookInstrumentation>[0];
    expect(() => installHookInstrumentation(fakeClient)()).not.toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/*  Basic emission — pre_tool / post_tool / on_error                        */
/* ------------------------------------------------------------------------ */

describe("installHookInstrumentation — basic emission", () => {
  it("emits a hook span for a pre_tool hook with correct metadata", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "web_search", input: { q: "x" }, output: "ok" }],
      hooks: [{ name: "audit-guard", kind: "pre_tool" }],
    });
    const spans = await collectSpans(async () => {
      installHookInstrumentation(client);
      for await (const _ev of client.query("prompt")) {
        void _ev;
      }
    });
    const hookSpans = spans.filter((s) => s.metadata?.tool_kind === "hook");
    expect(hookSpans).toHaveLength(1);
    expect(hookSpans[0]!.metadata?.hook?.kind).toBe("pre_tool");
    expect(hookSpans[0]!.metadata?.hook?.name).toBe("audit-guard");
    expect(hookSpans[0]!.type).toBe("tool");
    expect(hookSpans[0]!.name).toBe("anthropic-agent-sdk.hook.pre_tool.audit-guard");
  });

  it("emits a hook span for a post_tool hook", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "web_search", input: { q: "x" }, output: "ok" }],
      hooks: [{ name: "metric-stamp", kind: "post_tool" }],
    });
    const spans = await collectSpans(async () => {
      installHookInstrumentation(client);
      for await (const _ev of client.query("p")) void _ev;
    });
    const hookSpans = spans.filter((s) => s.metadata?.tool_kind === "hook");
    expect(hookSpans).toHaveLength(1);
    expect(hookSpans[0]!.metadata?.hook?.kind).toBe("post_tool");
    expect(hookSpans[0]!.metadata?.hook?.name).toBe("metric-stamp");
  });

  it("emits a hook span for an on_error hook", async () => {
    const client = new FakeClaudeSDKClient({
      hooks: [{ name: "alert", kind: "on_error" }],
    });
    const spans = await collectSpans(async () => {
      installHookInstrumentation(client);
      for await (const _ev of client.query("p")) void _ev;
    });
    const hookSpans = spans.filter((s) => s.metadata?.tool_kind === "hook");
    expect(hookSpans).toHaveLength(1);
    expect(hookSpans[0]!.metadata?.hook?.kind).toBe("on_error");
  });

  it("emits one span per fired hook (multiple of same kind)", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "t1", input: {}, output: "" }],
      hooks: [
        { name: "h1", kind: "pre_tool" },
        { name: "h2", kind: "pre_tool" },
        { name: "h3", kind: "pre_tool" },
      ],
    });
    const spans = await collectSpans(async () => {
      installHookInstrumentation(client);
      for await (const _ev of client.query("p")) void _ev;
    });
    const hookSpans = spans.filter((s) => s.metadata?.tool_kind === "hook");
    expect(hookSpans).toHaveLength(3);
    const names = hookSpans.map((s) => s.metadata?.hook?.name).sort();
    expect(names).toEqual(["h1", "h2", "h3"]);
  });
});

/* ------------------------------------------------------------------------ */
/*  Sibling linkage via toolSpanLookup                                       */
/* ------------------------------------------------------------------------ */

describe("installHookInstrumentation — sibling linkage", () => {
  it("attaches hook span to the tool's parent when toolSpanLookup resolves", async () => {
    // Drive hook emission manually so we control both the tool span lifecycle
    // and the hook payload (with tool_use_id) within a single trace.
    const client = new FakeClaudeSDKClient({});
    let toolParentId: string | undefined;
    let toolSpanId: string | undefined;
    let hookParentId: string | undefined;

    await runAsync({ agentName: "test-agent" }, async () => {
      const toolHandle = startSpan({
        name: "anthropic-agent-sdk.tool.web_search",
        type: "tool",
      });
      expect(toolHandle).not.toBeNull();
      toolSpanId = toolHandle!.span.span_id;
      toolParentId = toolHandle!.span.parent_span_id;

      installHookInstrumentation(client, {
        toolSpanLookup: (toolUseId) => (toolUseId === "toolu_42" ? toolSpanId! : null),
      });

      // Fake exposes `on`; we need to simulate the SDK firing the event with
      // a tool_use_id payload. Use the public listener wiring already in place.
      // The fake's `fire` is private; we cover this by calling the on/off path
      // indirectly via a fresh handler. Instead, use any-cast to invoke fire.
      (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
        name: "verify",
        kind: "post_tool",
        tool_use_id: "toolu_42",
      });

      const state = inspectTraceState();
      const hookSpan = state?.completedSpans.find(
        (s) => s.metadata && (s.metadata as Record<string, unknown>).tool_kind === "hook",
      );
      expect(hookSpan).toBeDefined();
      hookParentId = hookSpan?.parent_span_id;

      toolHandle!.end();
    });

    // Hook must share the tool's parent_span_id (i.e. be a sibling, not a child).
    expect(hookParentId).toBe(toolParentId);
    expect(hookParentId).not.toBe(toolSpanId);
  });

  it("falls back to top-of-stack parent when no toolSpanLookup is provided", async () => {
    const client = new FakeClaudeSDKClient({});
    let rootSpanId: string | undefined;
    let hookParentId: string | undefined;

    await runAsync({ agentName: "test-agent" }, async () => {
      const root = inspectTraceState();
      rootSpanId = root?.spanStack[root.spanStack.length - 1]?.span_id;

      installHookInstrumentation(client);
      (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
        name: "standalone",
        kind: "pre_tool",
      });

      const after = inspectTraceState();
      const hookSpan = after?.completedSpans.find(
        (s) => s.metadata && (s.metadata as Record<string, unknown>).tool_kind === "hook",
      );
      hookParentId = hookSpan?.parent_span_id;
    });

    expect(hookParentId).toBe(rootSpanId);
  });

  it("falls back to plain hook span when lookup returns null for unknown tool_use_id", async () => {
    const client = new FakeClaudeSDKClient({});
    let emittedKind: string | undefined;

    await runAsync({ agentName: "test-agent" }, async () => {
      installHookInstrumentation(client, {
        toolSpanLookup: () => null,
      });
      (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
        name: "orphan",
        kind: "pre_tool",
        tool_use_id: "toolu_unknown",
      });
      const state = inspectTraceState();
      const hookSpan = state?.completedSpans.find(
        (s) => s.metadata && (s.metadata as Record<string, unknown>).tool_kind === "hook",
      );
      emittedKind = hookSpan?.metadata
        ? ((hookSpan.metadata as Record<string, unknown>).tool_kind as string)
        : undefined;
    });

    expect(emittedKind).toBe("hook");
  });
});

/* ------------------------------------------------------------------------ */
/*  Unsubscribe semantics                                                    */
/* ------------------------------------------------------------------------ */

describe("installHookInstrumentation — unsubscribe", () => {
  it("stops emitting spans after the returned unsubscribe is called", async () => {
    const client = new FakeClaudeSDKClient({});
    let hookCountBefore = 0;
    let hookCountAfter = 0;

    await runAsync({ agentName: "test-agent" }, async () => {
      const unsub = installHookInstrumentation(client);

      (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
        name: "first",
        kind: "pre_tool",
      });
      const mid = inspectTraceState();
      hookCountBefore = (mid?.completedSpans ?? []).filter(
        (s) => s.metadata && (s.metadata as Record<string, unknown>).tool_kind === "hook",
      ).length;

      unsub();

      (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
        name: "second",
        kind: "pre_tool",
      });
      const after = inspectTraceState();
      hookCountAfter = (after?.completedSpans ?? []).filter(
        (s) => s.metadata && (s.metadata as Record<string, unknown>).tool_kind === "hook",
      ).length;
    });

    expect(hookCountBefore).toBe(1);
    expect(hookCountAfter).toBe(1); // unchanged after unsubscribe
  });
});

/* ------------------------------------------------------------------------ */
/*  Payload metadata + validation                                            */
/* ------------------------------------------------------------------------ */

describe("installHookInstrumentation — payload handling", () => {
  it("propagates duration_ms into metadata.hook.duration_ms", async () => {
    const client = new FakeClaudeSDKClient({});
    let durationMs: number | undefined;

    await runAsync({ agentName: "test-agent" }, async () => {
      installHookInstrumentation(client);
      (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
        name: "timed",
        kind: "post_tool",
        duration_ms: 42,
      });
      const state = inspectTraceState();
      const hookSpan = state?.completedSpans.find(
        (s) => s.metadata && (s.metadata as Record<string, unknown>).tool_kind === "hook",
      );
      const meta = hookSpan?.metadata as { hook?: { duration_ms?: number } } | undefined;
      durationMs = meta?.hook?.duration_ms;
    });

    expect(durationMs).toBe(42);
  });

  it("emits no span and does not throw when payload is missing required fields", async () => {
    const client = new FakeClaudeSDKClient({});
    let hookSpanCount = 0;
    let threw = false;

    await runAsync({ agentName: "test-agent" }, async () => {
      installHookInstrumentation(client);
      try {
        // Missing `kind`
        (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
          name: "incomplete",
        });
        // Missing `name`
        (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
          kind: "pre_tool",
        });
        // Unknown kind
        (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", {
          name: "weird",
          kind: "made_up_kind",
        });
        // Non-object payload
        (client as unknown as { fire: (e: string, p: unknown) => void }).fire("hook", null);
      } catch {
        threw = true;
      }
      const state = inspectTraceState();
      hookSpanCount = (state?.completedSpans ?? []).filter(
        (s) => s.metadata && (s.metadata as Record<string, unknown>).tool_kind === "hook",
      ).length;
    });

    expect(threw).toBe(false);
    expect(hookSpanCount).toBe(0);
  });
});
