/**
 * A failed OTLP export must be counted, not just logged (MHQ-1030).
 *
 * The bug this pins: an ingest 429 made the exporter retry, give up, and
 * discard the batch, leaving one line in the host's stdout and nothing
 * anywhere else — no counter, no diagnostic, no dashboard signal. A
 * rate-limited window and a healthy one were indistinguishable from both
 * sides.
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as diagnostics from "../src/_internal/diagnostics";
import { DropReportingExporter } from "../src/_internal/otel-provider";

/** Stub inner exporter that answers every batch with `result`. */
function inner(result: ExportResult): SpanExporter {
  return {
    export: (_spans, cb) => cb(result),
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}

/** The `OTLPExporterError` shape: an Error carrying the HTTP status as `code`. */
function otlpError(code?: number): Error {
  return Object.assign(new Error("stub"), { code, name: "OTLPExporterError" });
}

const SPANS = [{} as ReadableSpan, {} as ReadableSpan];

describe("failed OTLP exports are counted (MHQ-1030)", () => {
  beforeEach(() => {
    diagnostics.drainCounters();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    [429, "quota_rejected"],
    [401, "auth_rejected"],
    [403, "auth_rejected"],
    [404, "endpoint_rejected"],
    [413, "endpoint_rejected"],
  ])("status %i is reported as %s", (code, reason) => {
    const exporter = new DropReportingExporter(
      inner({ code: ExportResultCode.FAILED, error: otlpError(code) }),
    );

    exporter.export(SPANS, () => {});

    expect(diagnostics.drainCounters()).toEqual([{ reason, category: "span", quantity: 2 }]);
  });

  it("a retryable give-up carries no status and is reported as retry_exhausted", () => {
    // The exporter discards the status for retryable failures (429/5xx and
    // network faults) — by the time the callback fires it has already retried,
    // honoured Retry-After, and spent its budget.
    const exporter = new DropReportingExporter(
      inner({ code: ExportResultCode.FAILED, error: otlpError(undefined) }),
    );

    exporter.export(SPANS, () => {});

    expect(diagnostics.drainCounters()).toEqual([
      { reason: "retry_exhausted", category: "span", quantity: 2 },
    ]);
  });

  it("counts nothing on success", () => {
    const exporter = new DropReportingExporter(inner({ code: ExportResultCode.SUCCESS }));

    exporter.export(SPANS, () => {});

    expect(diagnostics.drainCounters()).toEqual([]);
  });

  it("passes the result through untouched — this tap never alters delivery", () => {
    const result: ExportResult = { code: ExportResultCode.FAILED, error: otlpError(429) };
    const exporter = new DropReportingExporter(inner(result));
    const seen: ExportResult[] = [];

    exporter.export(SPANS, (r) => seen.push(r));

    expect(seen).toEqual([result]);
  });

  it("warns the host with a count — nothing we learn is private (SDKDIAG-10)", () => {
    const exporter = new DropReportingExporter(
      inner({ code: ExportResultCode.FAILED, error: otlpError(429) }),
    );

    exporter.export(SPANS, () => {});

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("dropped 2 span"));
  });
});
