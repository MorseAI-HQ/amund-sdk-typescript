/**
 * Browser traces must reach the JSON transport, not the floor.
 *
 * This is the assertion that actually matters for the browser build: with
 * the OTLP pipeline unavailable, `tracing.ts::sendTrace` has to fall through
 * to the legacy JSON transport. If that routing is ever removed, every
 * browser consumer silently stops reporting — no error, no log, no trace —
 * which is precisely the failure MHQ-758 already shipped once.
 *
 * Lives in its own file because `vi.mock` is hoisted per-module-graph;
 * mocking the provider inside the shared test file would leak into every
 * other case there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Stand in for what the esbuild plugin does at build time: swap the Node
// provider for a browser-shaped one. `isOtelAvailable: false` is the single
// bit that drives the routing decision under test.
vi.mock("../src/_internal/otel-provider", () => ({
  isOtelAvailable: () => false,
  emitTraceEntry: () => {
    throw new Error("emitTraceEntry must not be called when OTel is unavailable");
  },
  withOtelSpanContext: <T>(_t: string, _s: string, fn: () => T): T => fn(),
  getEngine: () => ({
    configure() {},
    shutdown() {},
    resetForTesting() {},
    async flush() {},
    resolveSampled: () => true,
    registerInstrumentations: () => null,
  }),
  DEFAULT_MAX_FIELD_BYTES: 65536,
  TRUNCATION_MARKER: "…[truncated]",
}));

const { sendTrace, setTransport } = await import("../src/_internal/tracing");

interface Captured {
  traces: Array<{ trace: Record<string, unknown>; spans: Record<string, unknown>[] }>;
}

function fakeTransport(sink: Captured[]) {
  return {
    track(payload: Captured): boolean {
      sink.push(payload);
      return true;
    },
    flush: async () => {},
    shutdown: async () => {},
  } as never;
}

describe("browser build — trace delivery", () => {
  beforeEach(() => {
    setTransport(null as never);
  });

  it("routes the trace to the JSON transport instead of dropping it", () => {
    const sink: Captured[] = [];
    setTransport(fakeTransport(sink));

    const entry = {
      trace: { trace_id: "a".repeat(32), agent_name: "browser-agent" },
      spans: [{ span_id: "b".repeat(32), name: "root" }],
    };
    sendTrace(entry);

    expect(sink, "browser trace was dropped instead of sent").toHaveLength(1);
    expect(sink[0]?.traces?.[0]?.trace?.agent_name).toBe("browser-agent");
    expect(sink[0]?.traces?.[0]?.spans).toHaveLength(1);
  });

  it("does not throw when no transport is configured yet", () => {
    // Uninitialized SDK: dropping is correct here, crashing the host app is not.
    expect(() => sendTrace({ trace: { trace_id: "c".repeat(32) }, spans: [] })).not.toThrow();
  });
});
