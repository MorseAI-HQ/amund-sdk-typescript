/**
 * Auto-detect (zero-config instrumentation) tests — MHQ-482.
 *
 * Mirrors the granularity of the Python SDK's
 * `apps/sdk/python/tests/test_auto_detect.py`:
 *   - `morse.init()` / env-based lazy auto-init triggers `installAdapters()`
 *   - `MORSE_DISABLE_AUTO_DETECT=1` short-circuits the scan
 *   - already-loaded target packages install immediately
 *   - not-yet-loaded target packages install lazily via the `require()` hook
 *   - repeated calls / repeated requires never double-install
 *   - a package that isn't installed at all is skipped without error
 *   - auto-detect + a manual `wrapAnthropic()` call on the same client never
 *     double-records a span (the `globalInstallActive` guard added to
 *     `src/anthropic/index.ts` for this task)
 *
 * Real target packages (`@anthropic-ai/sdk`, `ai`) are intentionally NOT
 * used for the require/hook mechanics tests below — their CJS/ESM shape is
 * an implementation detail of a third-party package we don't control, and
 * flip-flopping between formats across versions would make the test flaky.
 * Instead, `tests/fixtures/fake-adapter-target.cjs` stands in as a
 * temporarily-registered target (mutating the exported `FULL_INSTALL_
 * TARGETS` / `DETECT_ONLY_TARGETS` maps in place, then restoring them) so
 * the require/hook plumbing itself is exercised deterministically.
 */

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import {
  _internalsForTesting,
  _resetForTesting as _resetAutoDetectForTesting,
  installAdapters,
} from "../src/_internal/auto-detect";
import {
  _resetAnthropicInstallStateForTesting,
  instrumentAnthropic,
  uninstallAnthropic,
  wrapAnthropic,
  type AnthropicClientLike,
} from "../src/anthropic/index";
import { type BatchTransport } from "../src/_internal/transport";

const nodeRequire = createRequire(import.meta.url);
const FIXTURE_PATH = nodeRequire.resolve("./fixtures/fake-adapter-target.cjs");
const MISSING_PACKAGE = "@morsehq/definitely-not-a-real-package-xyz";

function installMockTransport(): { events: unknown[] } {
  const state = { events: [] as unknown[] };
  morse._setTransportFactoryForTesting(
    () =>
      ({
        track(event: unknown): boolean {
          state.events.push(event);
          return true;
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      }) as unknown as BatchTransport,
  );
  return state;
}

/** Remove the fixture from require.cache so it looks "not yet loaded". */
function evictFixtureFromCache(): void {
  delete nodeRequire.cache[FIXTURE_PATH];
}

/** Wait a few microtask ticks for fire-and-forget async install() calls. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  morse._resetForTesting();
  _resetAutoDetectForTesting();
  _resetAnthropicInstallStateForTesting();
  evictFixtureFromCache();
  delete process.env.MORSE_DISABLE_AUTO_DETECT;
});

afterEach(() => {
  morse._resetForTesting();
  _resetAutoDetectForTesting();
  _resetAnthropicInstallStateForTesting();
  delete process.env.MORSE_DISABLE_AUTO_DETECT;
  delete process.env.MORSE_API_KEY;
  // Restore the real target catalogues in case a test mutated them.
  for (const key of Object.keys(_internalsForTesting.FULL_INSTALL_TARGETS)) {
    if (key === FIXTURE_PATH) delete _internalsForTesting.FULL_INSTALL_TARGETS[key];
  }
  for (const key of Object.keys(_internalsForTesting.DETECT_ONLY_TARGETS)) {
    if (key === FIXTURE_PATH) delete _internalsForTesting.DETECT_ONLY_TARGETS[key];
  }
  evictFixtureFromCache();
});

/* ------------------------------------------------------------------------ */
/*  init() integration                                                       */
/* ------------------------------------------------------------------------ */

describe("installAdapters — init() wiring", () => {
  it("morse.init() triggers installAdapters() (fire-and-forget)", async () => {
    installMockTransport();
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };
    nodeRequire(FIXTURE_PATH); // already-loaded

    morse.init({ apiKey: "mhq_test" }); // pragma: allowlist secret
    await flushMicrotasks();

    expect(install).toHaveBeenCalledTimes(1);
  });

  it("env-based lazy auto-init triggers installAdapters() too", async () => {
    installMockTransport();
    process.env.MORSE_API_KEY = "mhq_env_test"; // pragma: allowlist secret
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };
    nodeRequire(FIXTURE_PATH);

    morse.track({ agentId: "a", runData: {} }); // first public call auto-inits
    await flushMicrotasks();

    expect(install).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
/*  Opt-out                                                                   */
/* ------------------------------------------------------------------------ */

describe("MORSE_DISABLE_AUTO_DETECT", () => {
  it("short-circuits the scan — install() never called", async () => {
    process.env.MORSE_DISABLE_AUTO_DETECT = "1";
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };
    nodeRequire(FIXTURE_PATH);

    await installAdapters();

    expect(install).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ */
/*  Already-loaded vs. lazy-hook detection                                   */
/* ------------------------------------------------------------------------ */

describe("installAdapters — already-loaded targets", () => {
  it("installs immediately when the target is already require()d", async () => {
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };
    const mod = nodeRequire(FIXTURE_PATH);

    await installAdapters();

    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(mod);
  });
});

describe("installAdapters — lazy require() hook", () => {
  it("registers a lazy target and installs once require() fires", async () => {
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };

    await installAdapters();
    expect(install).not.toHaveBeenCalled();
    expect(_internalsForTesting.lazyTargets.has(FIXTURE_PATH)).toBe(true);
    expect(_internalsForTesting.hookInstalled).toBe(true);

    // Simulate the customer's code requiring the package after init().
    nodeRequire(FIXTURE_PATH);
    await flushMicrotasks();

    expect(install).toHaveBeenCalledTimes(1);
  });

  it("does not fire the hook for unrelated require() calls", async () => {
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };

    await installAdapters();
    nodeRequire.resolve("node:crypto"); // resolve only, no require call
    await flushMicrotasks();

    expect(install).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ */
/*  Idempotency / no double-install                                          */
/* ------------------------------------------------------------------------ */

describe("installAdapters — idempotency", () => {
  it("calling installAdapters() repeatedly never reinstalls an already-fired target", async () => {
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };
    nodeRequire(FIXTURE_PATH);

    await installAdapters();
    await installAdapters();
    await installAdapters();

    expect(install).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire the lazy hook if require()d multiple times", async () => {
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install };

    await installAdapters();
    nodeRequire(FIXTURE_PATH);
    nodeRequire(FIXTURE_PATH); // cached — no reload, but hook must not double-fire
    await flushMicrotasks();

    expect(install).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
/*  Missing library — non-invasive guarantee                                 */
/* ------------------------------------------------------------------------ */

describe("installAdapters — missing library", () => {
  it("skips a target package that isn't installed at all, without throwing", async () => {
    const install = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[MISSING_PACKAGE] = { install };

    await expect(installAdapters()).resolves.toBeUndefined();

    expect(install).not.toHaveBeenCalled();
    expect(_internalsForTesting.lazyTargets.has(MISSING_PACKAGE)).toBe(false);

    delete _internalsForTesting.FULL_INSTALL_TARGETS[MISSING_PACKAGE];
  });

  it("absorbs an individual target's install() failure without breaking others", async () => {
    const broken = vi.fn(async () => {
      throw new Error("boom");
    });
    const healthy = vi.fn(async () => true);
    _internalsForTesting.FULL_INSTALL_TARGETS[FIXTURE_PATH] = { install: broken };
    // A second real fixture path reused as a second "package" — same file,
    // different key is fine since installFullTarget() dedupes by key, not path.
    _internalsForTesting.FULL_INSTALL_TARGETS[MISSING_PACKAGE] = { install: healthy };
    nodeRequire(FIXTURE_PATH);

    await expect(installAdapters()).resolves.toBeUndefined();

    expect(broken).toHaveBeenCalledTimes(1);
    delete _internalsForTesting.FULL_INSTALL_TARGETS[MISSING_PACKAGE];
  });
});

/* ------------------------------------------------------------------------ */
/*  Detect-only targets — informational, never auto-installed                */
/* ------------------------------------------------------------------------ */

describe("installAdapters — detect-only targets", () => {
  it("logs once when a detect-only package is present, never calls install", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    _internalsForTesting.DETECT_ONLY_TARGETS[FIXTURE_PATH] = "someManualWrap(instance)";

    await installAdapters();
    await installAdapters(); // second call must not log again

    const matching = infoSpy.mock.calls.filter((args) =>
      String(args[0]).includes("someManualWrap(instance)"),
    );
    expect(matching.length).toBe(1);

    infoSpy.mockRestore();
    delete _internalsForTesting.DETECT_ONLY_TARGETS[FIXTURE_PATH];
  });
});

/* ------------------------------------------------------------------------ */
/*  Real adapter double-wrap prevention (anthropic)                          */
/* ------------------------------------------------------------------------ */

describe("auto-detect + manual wrap — no double instrumentation", () => {
  class FakeMessages {
    async create(params: { model: string }): Promise<unknown> {
      return {
        id: "msg_1",
        model: params.model,
        usage: { input_tokens: 3, output_tokens: 5 },
        content: [{ type: "text", text: "ok" }],
      };
    }
  }

  afterEach(async () => {
    await uninstallAnthropic({ Messages: FakeMessages });
  });

  it("wrapAnthropic() on a client is a no-op once a global install is active", async () => {
    installMockTransport();
    process.env.MORSE_API_KEY = "mhq_x"; // pragma: allowlist secret
    morse.init({ apiKey: "mhq_x" }); // pragma: allowlist secret

    const fakeAnthropicModule = { Messages: FakeMessages };
    const installed = await instrumentAnthropic({ anthropicModule: fakeAnthropicModule });
    expect(installed).toBe(true);

    const client = { messages: new FakeMessages() } as unknown as AnthropicClientLike;
    const wrapped = wrapAnthropic(client);

    // The double-wrap guard means wrapAnthropic() returns the client
    // unmodified (not a Proxy) — the global prototype patch stays the sole
    // recorder.
    expect(wrapped).toBe(client);

    await wrapped.messages.create({ model: "claude-haiku-4-5", messages: [] } as never);
    await morse.flush();

    // Exactly ONE llm span should have been recorded — not two. MHQ-482:
    // run()/span() go through the real OTel pipeline now, not
    // `transport.track()` — read the closed trace back the same way
    // tests/anthropic-context-segments.test.ts does post-otel-provider.
    const last = morse._getLastTraceForTesting() as { spans: Array<{ type: string }> } | null;
    const llmSpanCount = (last?.spans ?? []).filter((s) => s.type === "llm").length;
    expect(llmSpanCount).toBe(1);
  });
});
