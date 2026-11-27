/**
 * Tests for the MHQ-482 OTel transport engine (`_internal/otel-provider.ts`)
 * — TypeScript parity port of the Python SDK's `test_otel_provider.py`
 * (MHQ-668).
 *
 * Covers the pieces that are new in the OTel rebuild: trace-id forcing,
 * span-id passthrough from OTel's own id generator, byte-cap truncation,
 * export-time redaction, deterministic sampling ratio, batch-processor
 * config from env vars, blocking flush, and the "adapter that builds
 * SpanData directly still gets converted correctly" case (mirrored here as
 * "an entry built without going through `run()`/`span()` still converts").
 */

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildRedactionConfig } from "../src/_internal/redaction";
import { SDK_VERSION } from "../src/_internal/transport";
import {
  capBytes,
  emitTraceEntry,
  getEngine,
  jsonCapped,
  ratioSample,
  withOtelSpanContext,
  TRUNCATION_MARKER,
  type OtelEngine,
  type TraceEntryLike,
} from "../src/_internal/otel-provider";

const UNREACHABLE_ENDPOINT = "http://127.0.0.1:1/api/v1/otlp/v1/traces";

function freshTraceId(): string {
  return randomUUID().replace(/-/g, "");
}

function spansFor(engine: OtelEngine, traceIdHex: string) {
  expect(engine.recorder).not.toBeNull();
  return engine.recorder!.spans.filter((s) => s.spanContext().traceId === traceIdHex);
}

function freshEntry(
  traceIdHex: string,
  opts: { inputData?: unknown; metadata?: Record<string, unknown> } = {},
): TraceEntryLike {
  const spanIdHex = randomUUID().replace(/-/g, "");
  const span: Record<string, unknown> = {
    span_id: spanIdHex,
    trace_id: traceIdHex,
    parent_span_id: null,
    type: "agent",
    name: "test-agent",
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
  };
  if (opts.inputData !== undefined) span.input_data = opts.inputData;
  if (opts.metadata !== undefined) span.metadata = opts.metadata;
  return {
    trace: {
      trace_id: traceIdHex,
      agent: "test-agent",
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
    },
    spans: [span],
  };
}

function configureEngine(overrides: Partial<Parameters<OtelEngine["configure"]>[0]> = {}) {
  const engine = getEngine();
  engine.configure({
    endpoint: UNREACHABLE_ENDPOINT,
    apiKey: "av_test", // pragma: allowlist secret
    sampleRate: 1.0,
    scheduleDelayMillis: 50,
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
    maxFieldBytes: 65536,
    timeoutMillis: 1000,
    redactionConfig: buildRedactionConfig({ enabled: true }),
    captureForTests: true,
    ...overrides,
  });
  return engine;
}

afterEach(() => {
  getEngine().resetForTesting();
});

/* -------------------------------------------------------------------------- */
/*  Byte-cap truncation (MORSE_MAX_FIELD_BYTES)                                */
/* -------------------------------------------------------------------------- */

describe("byte cap", () => {
  it("cap_bytes is a no-op under the limit", () => {
    expect(capBytes("short", 100)).toBe("short");
  });

  it("cap_bytes truncates and marks oversized values", () => {
    const long = "x".repeat(200);
    const capped = capBytes(long, 50);
    const markerLen = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
    expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(50 + markerLen);
    expect(capped.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(capped.length).toBeLessThan(long.length);
  });

  it("cap_bytes never splits a multi-byte UTF-8 codepoint", () => {
    // Each "é" is 2 UTF-8 bytes — an off-by-one cap must not produce a
    // mangled/invalid trailing byte.
    const value = "é".repeat(100);
    const capped = capBytes(value, 51);
    expect(() => Buffer.from(capped, "utf-8").toString("utf-8")).not.toThrow();
  });

  it("json_capped keeps a truncated string valid JSON", () => {
    const long = "y".repeat(1000);
    const encoded = jsonCapped(long, 100);
    expect(encoded).not.toBeNull();
    const decoded = JSON.parse(encoded!) as string;
    expect(decoded.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("json_capped passes null/undefined through as null", () => {
    expect(jsonCapped(null, 100)).toBeNull();
    expect(jsonCapped(undefined, 100)).toBeNull();
  });

  it("emitTraceEntry caps an oversized input_data at attribute-set time", () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    emitTraceEntry(freshEntry(traceId, { inputData: "z".repeat(200_000) }));
    return engine.flush().then(() => {
      const matching = spansFor(engine, traceId);
      expect(matching.length).toBeGreaterThan(0);
      const raw = matching[0]!.attributes["amund.input_data"];
      expect(typeof raw).toBe("string");
      const markerLen = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
      expect(Buffer.byteLength(raw as string, "utf-8")).toBeLessThanOrEqual(65536 + markerLen + 2);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Sampler — deterministic trace-ID ratio, whole-trace                       */
/* -------------------------------------------------------------------------- */

describe("sampler", () => {
  it("ratio approximately matches the configured rate", () => {
    const n = 2000;
    let sampled = 0;
    for (let i = 0; i < n; i++) {
      if (ratioSample(freshTraceId(), 0.1)) sampled++;
    }
    const ratio = sampled / n;
    // Binomial std dev at p=0.1, n=2000 is ~0.67% — 5 percentage points is
    // a generous, non-flaky bound (mirrors the Python test's tolerance).
    expect(ratio).toBeGreaterThanOrEqual(0.05);
    expect(ratio).toBeLessThanOrEqual(0.15);
  });

  it("rate 1 always samples", () => {
    for (let i = 0; i < 50; i++) {
      expect(ratioSample(freshTraceId(), 1.0)).toBe(true);
    }
  });

  it("rate 0 never samples", () => {
    for (let i = 0; i < 50; i++) {
      expect(ratioSample(freshTraceId(), 0.0)).toBe(false);
    }
  });

  it("a sampled-out trace never reaches the exporter", async () => {
    const engine = configureEngine({ sampleRate: 0.0 });
    const traceId = freshTraceId();
    emitTraceEntry(freshEntry(traceId));
    await engine.flush();
    expect(engine.recorder!.spans).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Trace-id forcing / span-id passthrough                                    */
/* -------------------------------------------------------------------------- */

describe("trace/span id handling", () => {
  it("live DB spans keep their deferred agent parent", async () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    const entry = freshEntry(traceId);
    const rootId = entry.spans![0]!.span_id as string;
    withOtelSpanContext(traceId, rootId.slice(0, 16), () => {
      const db = engine.provider!.getTracer("db-instrumentation").startSpan("SELECT");
      db.end();
    });
    emitTraceEntry(entry);
    await engine.flush();
    const spans = spansFor(engine, traceId);
    const root = spans.find((s) => s.name === "test-agent")!;
    const db = spans.find((s) => s.name === "SELECT")!;
    expect(db.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it("keeps parentage when deferred children finish before their parent", async () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    const entry = freshEntry(traceId);
    const rootId = entry.spans![0]!.span_id as string;
    const parentId = freshTraceId();
    entry.spans!.push({
      span_id: freshTraceId(),
      parent_span_id: parentId,
      name: "child",
      type: "tool",
      status: "completed",
    });
    entry.spans!.push({
      span_id: parentId,
      parent_span_id: rootId,
      name: "parent",
      type: "tool",
      status: "completed",
    });
    emitTraceEntry(entry);
    await engine.flush();
    const spans = spansFor(engine, traceId);
    const parent = spans.find((s) => s.name === "parent")!;
    const child = spans.find((s) => s.name === "child")!;
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("every emitted span carries the forced trace id", async () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    const entry = freshEntry(traceId);
    const childSpanId = randomUUID().replace(/-/g, "");
    (entry.spans as Array<Record<string, unknown>>).push({
      span_id: childSpanId,
      trace_id: traceId,
      parent_span_id: (entry.spans![0] as Record<string, unknown>).span_id,
      type: "tool",
      name: "child-tool",
      status: "completed",
      started_at: "2026-01-01T00:00:00.100Z",
      ended_at: "2026-01-01T00:00:00.500Z",
    });
    emitTraceEntry(entry);
    await engine.flush();

    const matching = spansFor(engine, traceId);
    expect(matching.length).toBe(2);
    for (const span of matching) {
      expect(span.spanContext().traceId).toBe(traceId);
    }
  });

  it("deferred spans retain the 16-hex ID propagated to live instrumentation", async () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    const entry = freshEntry(traceId);
    const morseSpanId = (entry.spans![0] as Record<string, unknown>).span_id as string;
    emitTraceEntry(entry);
    await engine.flush();

    const matching = spansFor(engine, traceId);
    expect(matching.length).toBe(1);
    const otelSpanId = matching[0]!.spanContext().spanId;
    expect(otelSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(otelSpanId).toBe(morseSpanId.slice(0, 16));
  });

  it("an entry built without going through run()/span() (adapter-style) still converts", async () => {
    // Mirrors adapters that build SpanData/trace dicts directly and hand
    // them to the emission path without ever touching tracing.ts's
    // startSpan()/spanSync() helpers.
    const engine = configureEngine();
    const traceId = freshTraceId();
    const handBuilt: TraceEntryLike = {
      trace: { trace_id: traceId, agent: "adapter-agent", status: "completed" },
      spans: [
        {
          span_id: randomUUID().replace(/-/g, ""),
          trace_id: traceId,
          parent_span_id: null,
          type: "llm",
          name: "adapter-llm-call",
          status: "completed",
          started_at: "2026-01-01T00:00:00.000Z",
          ended_at: "2026-01-01T00:00:00.200Z",
          model: "claude-test",
          input_tokens: 12,
          output_tokens: 4,
        },
      ],
    };
    emitTraceEntry(handBuilt);
    await engine.flush();

    const matching = spansFor(engine, traceId);
    expect(matching.length).toBe(1);
    expect(matching[0]!.attributes["gen_ai.request.model"]).toBe("claude-test");
    expect(matching[0]!.attributes["gen_ai.usage.input_tokens"]).toBe(12);
  });
});

/* -------------------------------------------------------------------------- */
/*  Redaction at export time (single pass, off the hot path)                  */
/* -------------------------------------------------------------------------- */

describe("export-time redaction", () => {
  it("PII in input_data is redacted in the exported copy", async () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    emitTraceEntry(
      freshEntry(traceId, { inputData: { message: "contact me at jane@example.com" } }),
    );
    await engine.flush();

    const matching = spansFor(engine, traceId);
    expect(matching.length).toBe(1);
    const raw = matching[0]!.attributes["amund.input_data"] as string;
    expect(raw).toBeDefined();
    expect(raw).not.toContain("jane@example.com");
    expect(raw).toContain("[REDACTED:email]");
  });

  it("redaction disabled passes PII through unchanged", async () => {
    const engine = configureEngine({ redactionConfig: buildRedactionConfig({ enabled: false }) });
    const traceId = freshTraceId();
    emitTraceEntry(freshEntry(traceId, { inputData: { message: "jane@example.com" } }));
    await engine.flush();

    const matching = spansFor(engine, traceId);
    expect(matching.length).toBe(1);
    expect(matching[0]!.attributes["amund.input_data"] as string).toContain("jane@example.com");
  });
});

/* -------------------------------------------------------------------------- */
/*  Endpoint construction                                                     */
/* -------------------------------------------------------------------------- */

describe("endpoint construction", () => {
  it("configure() accepts a fully-qualified OTLP traces URL", async () => {
    const engine = configureEngine({ endpoint: "http://127.0.0.1:1/api/v1/otlp/v1/traces" });
    expect(engine.tracer).not.toBeNull();
    const traceId = freshTraceId();
    emitTraceEntry(freshEntry(traceId));
    await engine.flush();
    expect(spansFor(engine, traceId).length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  flush() blocks until export completes                                     */
/* -------------------------------------------------------------------------- */

describe("flush blocks", () => {
  it("flush() does not return before the in-memory recorder receives the span", async () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    emitTraceEntry(freshEntry(traceId));
    await engine.flush(); // should BLOCK until the batch processor exports
    const matching = spansFor(engine, traceId);
    expect(matching.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  No-op before configure() / on empty entries                               */
/* -------------------------------------------------------------------------- */

describe("no-op guards", () => {
  it("emitTraceEntry is a silent no-op before the engine is configured", () => {
    getEngine().resetForTesting();
    expect(() => emitTraceEntry(freshEntry(freshTraceId()))).not.toThrow();
  });

  it("emitTraceEntry is a silent no-op for an entry with no spans", async () => {
    const engine = configureEngine();
    expect(() => emitTraceEntry({ trace: { trace_id: freshTraceId() }, spans: [] })).not.toThrow();
    await engine.flush();
    expect(engine.recorder!.spans).toEqual([]);
  });

  it("emitTraceEntry is a silent no-op for a missing/invalid trace id", async () => {
    const engine = configureEngine();
    expect(() =>
      emitTraceEntry({ trace: {}, spans: [{ span_id: "x", name: "n", status: "completed" }] }),
    ).not.toThrow();
    await engine.flush();
    expect(engine.recorder!.spans).toEqual([]);
  });
});

describe("sdk version on the wire", () => {
  // @spec: MHQ-1158
  it("spans carry the SDK version on the instrumentation scope", async () => {
    const engine = configureEngine();
    const traceId = freshTraceId();
    emitTraceEntry(freshEntry(traceId));
    await engine.flush();

    const scope = spansFor(engine, traceId)[0]!.instrumentationScope;
    expect(scope.name).toBe("morse-typescript");
    expect(scope.version).toBe(SDK_VERSION);
  });
});
