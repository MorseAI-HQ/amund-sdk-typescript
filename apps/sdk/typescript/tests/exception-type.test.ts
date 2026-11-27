/**
 * Failed spans carry the exception type (failure groups, ERRGRP-05).
 * Additive: `exception_type` is only set for a real thrown Error, and the OTel
 * exporter emits a `recordException`-shaped `exception` event for failed spans.
 */

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildRedactionConfig } from "../src/_internal/redaction";
import { emitTraceEntry, getEngine, type TraceEntryLike } from "../src/_internal/otel-provider";
import { errToTypeName } from "../src/_internal/tracing";

class CustomBoom extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomBoom";
  }
}

class NamelessBoom extends Error {}

afterEach(() => {
  getEngine().resetForTesting();
});

describe("errToTypeName", () => {
  it("uses the error name, falling back to the constructor name", () => {
    // @spec: ERRGRP-05
    expect(errToTypeName(new TypeError("x"))).toBe("TypeError");
    expect(errToTypeName(new CustomBoom("x"))).toBe("CustomBoom");
    expect(errToTypeName(new NamelessBoom("x"))).toBe("NamelessBoom");
    expect(errToTypeName(new Error("x"))).toBe("Error");
  });

  it("is undefined for non-Error throws", () => {
    // @spec: ERRGRP-05
    expect(errToTypeName("boom")).toBeUndefined();
    expect(errToTypeName(undefined)).toBeUndefined();
    expect(errToTypeName({ message: "x" })).toBeUndefined();
  });
});

describe("otel exporter", () => {
  it("emits an exception event with type and message for a failed span", async () => {
    // @spec: ERRGRP-05
    const engine = getEngine();
    engine.configure({
      endpoint: "http://127.0.0.1:1/api/v1/otlp/v1/traces",
      apiKey: "av_test", // pragma: allowlist secret
      sampleRate: 1.0,
      scheduleDelayMillis: 50,
      maxQueueSize: 4096,
      maxExportBatchSize: 512,
      maxFieldBytes: 65536,
      timeoutMillis: 1000,
      redactionConfig: buildRedactionConfig({ enabled: true }),
      captureForTests: true,
    });
    const traceId = randomUUID().replace(/-/g, "");
    const entry: TraceEntryLike = {
      trace: {
        trace_id: traceId,
        agent: "a",
        status: "failed",
        started_at: "2026-01-01T00:00:00.000Z",
      },
      spans: [
        {
          span_id: randomUUID().replace(/-/g, ""),
          trace_id: traceId,
          parent_span_id: null,
          type: "tool",
          name: "lookup",
          status: "failed",
          started_at: "2026-01-01T00:00:00.000Z",
          ended_at: "2026-01-01T00:00:01.000Z",
          error_message: "Timeout after 30ms",
          exception_type: "TimeoutError",
        },
      ],
    };
    emitTraceEntry(entry);
    await engine.flush();
    const span = engine.recorder!.spans.find((s) => s.spanContext().traceId === traceId)!;
    const event = span.events.find((e) => e.name === "exception");
    expect(event?.attributes?.["exception.type"]).toBe("TimeoutError");
    expect(event?.attributes?.["exception.message"]).toBe("Timeout after 30ms");
    expect(span.attributes["amund.exception_type"]).toBe("TimeoutError");
  });
});
