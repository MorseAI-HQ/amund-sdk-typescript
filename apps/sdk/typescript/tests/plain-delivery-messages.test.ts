/**
 * Plain-language delivery messages (offshore QA round 2, MHQ-1838).
 *
 * A truncated key, a rejected key and an offline machine each used to surface
 * as an OpenTelemetry internal (`OTLPExporterError: Unauthorized`,
 * `getaddrinfo ENOTFOUND`) with a silent wait before it. These pin the text the
 * host sees instead. Text only: counting and delivery are covered elsewhere.
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as diagnostics from "../src/_internal/diagnostics";
import { apiKeyShapeProblem } from "../src/_internal/env";
import { DropReportingExporter } from "../src/_internal/otel-provider";
import { BatchTransport } from "../src/_internal/transport";
import * as morse from "../src/index";

const HEX64 = "0123456789abcdef".repeat(4);
const SPANS = [{} as ReadableSpan];

function inner(result: ExportResult, delayMs = 0): SpanExporter {
  return {
    export: (_spans, cb) => {
      if (delayMs > 0) setTimeout(() => cb(result), delayMs);
      else cb(result);
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
}

function warnings(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c: unknown[]) => String(c[0]));
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  diagnostics._resetForTesting();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  diagnostics._resetForTesting();
});

describe("API key shape check", () => {
  it.each([`mhq_${HEX64}`, `mhq_prod_${HEX64}`, `mhq_dev_${HEX64}`, `mhq_pk_stag_${HEX64}`])(
    "accepts a well-formed key",
    (key) => {
      expect(apiKeyShapeProblem(key)).toBeNull();
    },
  );

  it.each([
    [`mhq_prod_${HEX64.slice(0, 40)}`, "it looks truncated or mistyped"],
    [`"mhq_prod_${HEX64}"`, "it is wrapped in quotes"],
    [`mhq_prod_${HEX64} `, "it has leading or trailing spaces"],
    [`sk-${HEX64}`, "it does not start with mhq_"],
  ])("names the problem without echoing the key", (key, problem) => {
    expect(apiKeyShapeProblem(key)).toBe(problem);
  });

  it("init() warns once for a malformed key and still initialises", () => {
    morse._resetForTesting();
    morse.init({ apiKey: "mhq_prod_abc123", endpoint: "http://127.0.0.1:9/api/v1/traces/batch" }); // pragma: allowlist secret
    const lines = warnings(warnSpy).filter((l) => l.includes("looks malformed"));
    expect(lines).toEqual([
      "morse: Morse API key looks malformed (it looks truncated or mistyped). Check MORSE_API_KEY.",
    ]);
    expect(lines[0]).not.toContain("abc123");
    morse._resetForTesting();
  });

  it("init() says nothing for a well-formed key", () => {
    morse._resetForTesting();
    morse.init({
      apiKey: `mhq_prod_${HEX64}`, // pragma: allowlist secret
      endpoint: "http://127.0.0.1:9/api/v1/traces/batch",
    });
    expect(warnings(warnSpy).some((l) => l.includes("looks malformed"))).toBe(false);
    morse._resetForTesting();
  });
});

describe("OTLP path", () => {
  it("a 401 reads as a rejected key", () => {
    const err = Object.assign(new Error("Unauthorized"), { code: 401, name: "OTLPExporterError" });
    const exporter = new DropReportingExporter(
      inner({ code: ExportResultCode.FAILED, error: err }),
      "api.morseai.dev",
    );
    exporter.export(SPANS, () => {});
    expect(warnings(warnSpy)).toContain(
      "morse: Morse rejected the API key (401): 1 span(s) dropped. Check MORSE_API_KEY or get a new key in Settings → API keys.",
    );
  });

  it("a DNS failure reads as unreachable and says spans are not buffered", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.morseai.dev"), {
      code: "ENOTFOUND",
    });
    const exporter = new DropReportingExporter(
      inner({ code: ExportResultCode.FAILED, error: err }),
      "api.morseai.dev",
    );
    exporter.export(SPANS, () => {});
    expect(warnings(warnSpy)).toContain(
      "morse: Morse unreachable (api.morseai.dev): 1 span(s) dropped after retries. Spans are not buffered across outages.",
    );
    expect(diagnostics.drainCounters()).toEqual([
      { reason: "retry_exhausted", category: "span", quantity: 1 },
    ]);
  });

  it("says once that it is retrying when the answer is slow, and not when it is quick", async () => {
    vi.useFakeTimers();
    try {
      const slow = new DropReportingExporter(
        inner({ code: ExportResultCode.FAILED, error: new Error("ETIMEDOUT") }, 3_000),
        "api.morseai.dev",
        1_500,
      );
      slow.export(SPANS, () => {});
      slow.export(SPANS, () => {});
      await vi.advanceTimersByTimeAsync(3_100);
      const retrying = warnings(warnSpy).filter((l) => l.includes("retrying"));
      expect(retrying).toEqual(["morse: Morse not responding (api.morseai.dev), retrying…"]);

      warnSpy.mockClear();
      diagnostics.noteDelivered();
      const quick = new DropReportingExporter(
        inner({ code: ExportResultCode.SUCCESS }, 100),
        "api.morseai.dev",
        1_500,
      );
      quick.export(SPANS, () => {});
      await vi.advanceTimersByTimeAsync(2_000);
      expect(warnings(warnSpy)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("raw error detail is debug-only for explained failures", () => {
  it("hides the raw line unless MORSE_SDK_DEBUG is set", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    diagnostics.report(new Error("getaddrinfo ENOTFOUND api.morseai.dev"), {
      fingerprint: "morse.otel_provider.force_flush",
      localOnlyInDebug: true,
    });
    expect(warnings(warnSpy).some((l) => l.includes("morse internal error"))).toBe(false);

    vi.stubEnv("MORSE_SDK_DEBUG", "1");
    diagnostics.report(new Error("getaddrinfo ENOTFOUND api.morseai.dev"), {
      fingerprint: "morse.otel_provider.force_flush",
      localOnlyInDebug: true,
    });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("morse internal error [morse.otel_provider.force_flush]"),
      expect.anything(),
    );
  });

  it("classifies auth and network errors", () => {
    expect(diagnostics.isAuthError(Object.assign(new Error("x"), { code: 403 }))).toBe(true);
    expect(diagnostics.isAuthError(Object.assign(new Error("x"), { code: 404 }))).toBe(false);
    expect(diagnostics.isNetworkError(new Error("getaddrinfo ENOTFOUND api.morseai.dev"))).toBe(
      true,
    );
    expect(
      diagnostics.isNetworkError(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      ),
    ).toBe(true);
    expect(diagnostics.isNetworkError(Object.assign(new Error("Bad Gateway"), { code: 502 }))).toBe(
      false,
    );
  });

  it("classifies the array forceFlush rejects with", () => {
    const auth = Object.assign(new Error("Unauthorized"), { code: 401 });
    const dns = new Error("getaddrinfo ENOTFOUND api.morseai.dev");
    expect(diagnostics.isAuthError([auth])).toBe(true);
    expect(diagnostics.isNetworkError([dns])).toBe(true);
    expect(diagnostics.isAuthError([])).toBe(false);
    expect(diagnostics.isNetworkError([dns, new Error("boom")])).toBe(false);
  });
});

describe("JSON transport", () => {
  it("401: one plain line, no raw internal error", async () => {
    const transport = new BatchTransport({
      endpoint: "https://api.morseai.dev/api/v1/traces/batch",
      apiKey: "mhq_x", // pragma: allowlist secret
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl: vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();
    const lines = warnings(warnSpy);
    expect(lines).toContain(
      "morse: Morse rejected the API key (401): 1 trace(s) dropped. Check MORSE_API_KEY or get a new key in Settings → API keys.",
    );
    expect(lines.some((l) => l.includes("morse internal error"))).toBe(false);
  });

  it("offline: retrying line, then unreachable line, no raw internal error", async () => {
    const transport = new BatchTransport({
      endpoint: "https://api.morseai.dev/api/v1/traces/batch",
      apiKey: "mhq_x", // pragma: allowlist secret
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      flushTimeoutMs: 30_000,
      fetchImpl: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.morseai.dev");
      }) as unknown as typeof fetch,
    });
    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();
    const lines = warnings(warnSpy);
    expect(lines.filter((l) => l.includes("retrying"))).toEqual([
      "morse: Morse unreachable (api.morseai.dev), retrying…",
    ]);
    expect(lines).toContain(
      "morse: Morse unreachable (api.morseai.dev): 1 trace(s) dropped after retries. Traces are not buffered across outages.",
    );
    expect(lines.some((l) => l.includes("morse internal error"))).toBe(false);
  }, 20_000);
});
