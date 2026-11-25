/**
 * Public API tests for `@amundai/sdk`.
 *
 * Covers:
 *   - Module-level singleton API surface (init, track, batchTrack, record,
 *     run, span, flush, shutdown, version).
 *   - Env-based auto-init (track without prior init reads MORSE_API_KEY).
 *   - MORSE_DISABLED makes everything a no-op.
 *   - Non-invasive guarantee — no public function ever throws.
 *   - Destination-URL transparency log fires once per (process, endpoint).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { type BatchTransport } from "../src/_internal/transport";

interface MockTransport {
  events: Array<unknown>;
  flushCalls: number;
  shutdownCalls: number;
}

function installMockTransport(): MockTransport {
  const state: MockTransport = { events: [], flushCalls: 0, shutdownCalls: 0 };
  const factory = (): BatchTransport => {
    return {
      track(event: unknown): boolean {
        state.events.push(event);
        return true;
      },
      flush(): Promise<void> {
        state.flushCalls += 1;
        return Promise.resolve();
      },
      shutdown(): Promise<void> {
        state.shutdownCalls += 1;
        return Promise.resolve();
      },
      // The other private fields don't matter for these tests; we cast
      // through unknown so we don't have to mirror them all.
    } as unknown as BatchTransport;
  };
  morse._setTransportFactoryForTesting(factory);
  return state;
}

const ENV_KEYS = [
  "MORSE_API_KEY",
  "MORSE_ENDPOINT",
  "MORSE_DISABLED",
  "MORSE_FLUSH_INTERVAL_SECONDS",
  "MORSE_SDK_DEBUG",
  "MORSE_SDK_DISABLE_TELEMETRY",
];

beforeEach(() => {
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("public API surface", () => {
  it("exports module-level singleton functions", () => {
    expect(typeof morse.init).toBe("function");
    expect(typeof morse.track).toBe("function");
    expect(typeof morse.batchTrack).toBe("function");
    expect(typeof morse.record).toBe("function");
    expect(typeof morse.run).toBe("function");
    expect(typeof morse.runTraced).toBe("function");
    expect(typeof morse.span).toBe("function");
    expect(typeof morse.spanAsync).toBe("function");
    expect(typeof morse.startSpan).toBe("function");
    expect(typeof morse.flush).toBe("function");
    expect(typeof morse.shutdown).toBe("function");
    expect(typeof morse.injectTraceparent).toBe("function");
    expect(typeof morse.extractTraceparent).toBe("function");
    expect(typeof morse.linkRecord).toBe("function");
    expect(typeof morse.setPrompt).toBe("function");
    expect(typeof morse.version).toBe("string");
  });
});

describe("init() + explicit api key", () => {
  it("constructs a transport and logs the destination URL once", () => {
    const transport = installMockTransport();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    morse.init({ apiKey: "av_explicit", endpoint: "https://example.test/api" });
    morse.track({ agentId: "test", runData: { success: true } });

    expect(transport.events).toHaveLength(1);
    const calls = infoSpy.mock.calls.map((c) => String(c[0]));
    const initLogs = calls.filter((m) => m.includes("Amund SDK initialized"));
    expect(initLogs).toHaveLength(1);
    expect(initLogs[0]).toContain("https://example.test/api");
    infoSpy.mockRestore();
  });

  it("does not re-log when init() is called twice with the same endpoint", () => {
    installMockTransport();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    morse.init({ apiKey: "av_a", endpoint: "https://example.test/x" });
    morse.init({ apiKey: "av_a", endpoint: "https://example.test/x" });
    const initLogs = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("Amund SDK initialized"));
    expect(initLogs).toHaveLength(1);
    infoSpy.mockRestore();
  });

  it("re-logs when the endpoint changes", () => {
    installMockTransport();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    morse.init({ apiKey: "av_a", endpoint: "https://example.test/x" });
    morse.init({ apiKey: "av_a", endpoint: "https://example.test/y" });
    const initLogs = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("Amund SDK initialized"));
    expect(initLogs).toHaveLength(2);
    infoSpy.mockRestore();
  });
});

describe("env-based auto-init", () => {
  it("auto-initializes from MORSE_API_KEY on first track()", () => {
    const transport = installMockTransport();
    process.env.MORSE_API_KEY = "av_from_env";
    process.env.MORSE_ENDPOINT = "https://env.example/api";
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    morse.track({ agentId: "auto", runData: { success: true } });

    expect(transport.events).toHaveLength(1);
    const initLogs = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("Amund SDK initialized"));
    expect(initLogs).toHaveLength(1);
    expect(initLogs[0]).toContain("https://env.example/api");
    infoSpy.mockRestore();
  });

  it("logs one warning per process when the API key is unset", () => {
    installMockTransport();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    morse.track({ agentId: "noop1", runData: {} });
    morse.track({ agentId: "noop2", runData: {} });

    const noKeyWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("not initialized"));
    expect(noKeyWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

describe("MORSE_DISABLED", () => {
  it("makes init() and track() complete no-ops", () => {
    const transport = installMockTransport();
    process.env.MORSE_DISABLED = "1";
    process.env.MORSE_API_KEY = "av_x";

    morse.init({ apiKey: "av_x" });
    morse.track({ agentId: "x", runData: {} });
    morse.batchTrack([{ a: 1 }, { a: 2 }]);
    morse.record({ agent: "x", success: true });

    expect(transport.events).toHaveLength(0);
  });
});

describe("non-invasive guarantee", () => {
  it("track() returns undefined and does not throw on transport failure", () => {
    morse._setTransportFactoryForTesting(
      () =>
        ({
          track(): boolean {
            throw new Error("transport blew up");
          },
          flush(): Promise<void> {
            return Promise.resolve();
          },
          shutdown(): Promise<void> {
            return Promise.resolve();
          },
        }) as unknown as BatchTransport,
    );
    process.env.MORSE_API_KEY = "av_chaos";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => morse.track({ agentId: "x", runData: {} })).not.toThrow();
    warnSpy.mockRestore();
  });

  it("init() with a thrown factory does not break the caller", () => {
    morse._setTransportFactoryForTesting(() => {
      throw new Error("factory failed");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => morse.init({ apiKey: "av_x" })).not.toThrow();
    warnSpy.mockRestore();
  });

  it("public API never propagates exceptions even with malformed args", () => {
    process.env.MORSE_API_KEY = "av_x";
    installMockTransport();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // @ts-expect-error — intentionally wrong shape to force absorbErrors path.
    expect(() => morse.track(undefined)).not.toThrow();
    // @ts-expect-error — intentionally wrong shape.
    expect(() => morse.batchTrack(undefined)).not.toThrow();
    // @ts-expect-error — intentionally wrong shape.
    expect(() => morse.record(undefined)).not.toThrow();
    warnSpy.mockRestore();
  });
});

// MHQ-482: run()/runTraced()'s emission path now goes through the real OTel
// pipeline (`_internal/otel-provider.ts`), not the JSON `BatchTransport` —
// mirrors the Python SDK's MHQ-668 split (`_finish_trace` vs `_send_trace`).
// MHQ-746: `record()` was migrated the same way (mirrors Python's
// `client.py::record()`) — only `track()`/`batchTrack()`/`log()` still
// reach `installMockTransport()`'s `TransportLike` shim.
// `_getLastTraceForTesting()` stays wired up regardless of which pipeline
// actually ships the trace (see `tracing.ts::sendTrace`), so it's the right
// introspection point for `run()`/`runTraced()`/`record()` here.
function lastTrace(): { trace: Record<string, unknown>; spans: Array<Record<string, unknown>> } {
  const entry = morse._getLastTraceForTesting();
  expect(entry).not.toBeNull();
  return entry as { trace: Record<string, unknown>; spans: Array<Record<string, unknown>> };
}

describe("record() builds a wire payload", () => {
  it("maps RunRecord fields onto the trace + span", () => {
    process.env.MORSE_API_KEY = "av_x";

    morse.record({
      agent: "lead-qualifier",
      success: true,
      cost: 0.043,
      model: "claude-sonnet-4-5",
      inputTokens: 1234,
      outputTokens: 56,
      totalTokens: 1290,
      durationMs: 412,
    });

    const trace = lastTrace();
    expect(trace.trace.agent).toBe("lead-qualifier");
    expect(trace.trace.success).toBe(true);
    expect(trace.spans).toHaveLength(1);
    const span = trace.spans[0]!;
    expect(span.name).toBe("lead-qualifier");
    expect(span.type).toBe("agent");
    expect(span.cost_usd).toBe(0.043);
    expect(span.input_tokens).toBe(1234);
    expect(span.output_tokens).toBe(56);
    expect(span.total_tokens).toBe(1290);
    expect(span.duration_ms).toBe(412);
    expect(span.status).toBe("completed");
  });
});

describe("run() emits a trace via the transport", () => {
  it("captures the inner work as a single agent span", async () => {
    process.env.MORSE_API_KEY = "av_x";

    const result = await morse.runTraced({ agentName: "my-agent" }, async (handle) => {
      handle.setOutcome(true, "qualified");
      return 7;
    });

    expect(result).toBe(7);
    const trace = lastTrace();
    expect(trace.trace.agent).toBe("my-agent");
    expect(trace.trace.success).toBe(true);
    expect(trace.trace.outcome).toBe("qualified");
    expect(trace.spans.length).toBeGreaterThanOrEqual(1);
  });

  it("captures failure on a thrown error", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await expect(
      morse.runTraced({ agentName: "fail-agent" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const trace = lastTrace();
    expect(trace.trace.status).toBe("failed");
    expect(trace.trace.error_message).toBe("boom");
    // A crash is a fact — failure metrics and alerts filter on success=false.
    expect(trace.trace.success).toBe(false);
  });

  // @spec: MHQ-1157
  it("never guesses success on a clean exit when the caller didn't set outcome", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced({ agentName: "happy-agent" }, async () => "done");

    expect(lastTrace().trace.success).toBeUndefined();
    expect(lastTrace().trace.status).toBe("completed");
  });

  // @spec: MHQ-1157
  it("module-level setOutcome declares the active trace's outcome", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced({ agentName: "declared-agent" }, async () => {
      morse.setOutcome(true, "qualified");
    });

    expect(lastTrace().trace.success).toBe(true);
    expect(lastTrace().trace.outcome).toBe("qualified");
    expect(() => morse.setOutcome(false)).not.toThrow(); // outside a trace
  });

  it("explicit setOutcome wins over inference even when the run throws", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await expect(
      morse.runTraced({ agentName: "partial-agent" }, async (handle) => {
        handle.setOutcome(true, "partial");
        throw new Error("late failure");
      }),
    ).rejects.toThrow("late failure");

    const trace = lastTrace();
    expect(trace.trace.success).toBe(true);
    expect(trace.trace.outcome).toBe("partial");
  });
});

// MHQ-748: run() kwargs for multi-turn conversation grouping and
// cost-attribution dimensions, set at trace-creation time. Mirrors the
// Python SDK's `run(thread_id=..., user_id=..., user_metadata=..., source=...)`.
describe("run() thread/user/source attribution (MHQ-748)", () => {
  it("propagates threadId, userId, and userMetadata onto the trace dict", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced(
      {
        agentName: "chat-agent",
        threadId: "thread-123",
        userId: "user-456",
        userMetadata: { customerId: "acme", feature: "doc-qa" },
      },
      async () => "ok",
    );

    const trace = lastTrace();
    // Wire field names match the backend `TracePayloadIn` schema and the
    // sibling Python SDK's `_build_trace_dict` exactly — snake_case, not
    // camelCase.
    expect(trace.trace.thread_id).toBe("thread-123");
    expect(trace.trace.user_id).toBe("user-456");
    expect(trace.trace.user_metadata).toEqual({ customerId: "acme", feature: "doc-qa" });
  });

  it("coerces non-string userMetadata values to strings", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced(
      { agentName: "chat-agent", userMetadata: { retryCount: 3 as unknown as string } },
      async () => "ok",
    );

    const trace = lastTrace();
    expect(trace.trace.user_metadata).toEqual({ retryCount: "3" });
  });

  it("omits thread_id/user_id/user_metadata entirely when not provided", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced({ agentName: "plain-agent" }, async () => "ok");

    const trace = lastTrace();
    expect(trace.trace.thread_id).toBeUndefined();
    expect(trace.trace.user_id).toBeUndefined();
    expect(trace.trace.user_metadata).toBeUndefined();
  });

  it("honours a valid internal `source` override on the trace resource", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced({ agentName: "copilot-agent", source: "copilot" }, async () => "ok");

    const trace = lastTrace() as unknown as { resource?: Record<string, unknown> };
    // `git.revision` (ATTR-06) rides the same envelope when the checkout/CI has one, so
    // assert the source label rather than the whole object.
    expect(trace.resource).toMatchObject({ "morse_ai.source": "copilot" });
  });

  it("silently ignores an invalid `source` value", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced(
      { agentName: "bad-source-agent", source: "not-a-real-source" },
      async () => "ok",
    );

    const trace = lastTrace() as unknown as { resource?: Record<string, unknown> };
    // Absence of the label is the signal; `git.revision` may legitimately be present (ATTR-06).
    expect(trace.resource?.["morse_ai.source"]).toBeUndefined();
  });
});

// MHQ-751: setContext() attaches cost-attribution dimensions to the
// currently active trace, so every child span downstream inherits them.
// Mirrors the Python SDK's `morse_ai.set_context(**dims)`.
describe("setContext() (MHQ-751)", () => {
  it("merges dimensions into an active trace's user_metadata", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced(
      { agentName: "middleware-agent", userMetadata: { feature: "doc-qa" } },
      async () => {
        morse.setContext({ customerId: "acme" });
        return "ok";
      },
    );

    const trace = lastTrace();
    expect(trace.trace.user_metadata).toEqual({ feature: "doc-qa", customerId: "acme" });
  });

  it("overwrites an existing key on the same trace rather than duplicating it", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced(
      { agentName: "middleware-agent", userMetadata: { feature: "doc-qa" } },
      async () => {
        morse.setContext({ feature: "search" });
        return "ok";
      },
    );

    expect(lastTrace().trace.user_metadata).toEqual({ feature: "search" });
  });

  it("coerces non-string values via String()", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced({ agentName: "middleware-agent" }, async () => {
      morse.setContext({ retryCount: 3, enabled: true });
      return "ok";
    });

    expect(lastTrace().trace.user_metadata).toEqual({ retryCount: "3", enabled: "true" });
  });

  it("is a silent no-op with no active trace", () => {
    process.env.MORSE_API_KEY = "av_x";

    expect(() => morse.setContext({ customerId: "acme" })).not.toThrow();
    // No trace was ever opened, so there's nothing to assert against — the
    // point is purely that this never throws.
    expect(morse._getActiveTraceStateForTesting()).toBeNull();
  });
});
