/**
 * Phase 12.5 Tier 1.2 — TS `log()` export tests.
 *
 * Covers:
 *   - `log()` inside a `runTraced()` callback auto-correlates trace_id +
 *     span_id from the AsyncLocalStorage trace context.
 *   - `log()` outside a trace enqueues with `trace_id: null` and does
 *     not throw.
 *   - Transport network failures are absorbed — `log()` never propagates
 *     to the caller.
 *   - Default severity is `"INFO"`, default service_name is
 *     `"morse-sdk-ts"`. Overrides win.
 *   - Logs route to the derived `/api/v1/logs/ingest` URL, NOT the
 *     traces batch endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import {
  BatchTransport,
  deriveLogsEndpoint,
  type LogRecordPayload,
} from "../src/_internal/transport";

interface CapturedRequest {
  url: string;
  body: unknown;
}

function makeFetchSpy(): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
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

describe("log() — public API", () => {
  it("is exported from the module surface", () => {
    expect(typeof morse.log).toBe("function");
  });

  it("is a silent no-op when the SDK is not initialized", () => {
    // No init, no env var — `log()` must not throw.
    expect(() => morse.log("hello")).not.toThrow();
  });
});

describe("log() — trace correlation", () => {
  it("auto-correlates trace_id + span_id from an active runTraced() context", async () => {
    const captured: Array<{ event: unknown }> = [];
    morse._setTransportFactoryForTesting((): BatchTransport => {
      return {
        track(event: unknown): boolean {
          captured.push({ event });
          return true;
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as BatchTransport;
    });

    morse.init({ apiKey: "av_x", endpoint: "https://example.test/api/v1/traces/batch" });

    await morse.runTraced({ agentName: "test-agent" }, async () => {
      morse.log("hi");
    });

    const logEvents = captured.filter(
      (e) => typeof e.event === "object" && e.event !== null && "logs" in (e.event as object),
    );
    expect(logEvents).toHaveLength(1);
    const logs = (logEvents[0]!.event as { logs: LogRecordPayload[] }).logs;
    expect(logs).toHaveLength(1);
    const rec = logs[0]!;
    expect(rec.body).toBe("hi");
    expect(rec.severity).toBe("INFO");
    expect(rec.service_name).toBe("morse-sdk-ts");
    expect(rec.trace_id).toBeTruthy();
    expect(rec.span_id).toBeTruthy();
    // The trace state during runTraced should have produced a non-null
    // 32-hex trace_id (the SDK convention since PR #46).
    expect(rec.trace_id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("enqueues with trace_id: null outside a trace context", async () => {
    const captured: Array<{ event: unknown }> = [];
    morse._setTransportFactoryForTesting((): BatchTransport => {
      return {
        track(event: unknown): boolean {
          captured.push({ event });
          return true;
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as BatchTransport;
    });

    morse.init({ apiKey: "av_x", endpoint: "https://example.test/api/v1/traces/batch" });

    expect(() => morse.log("orphan-line")).not.toThrow();

    expect(captured).toHaveLength(1);
    const logs = (captured[0]!.event as { logs: LogRecordPayload[] }).logs;
    expect(logs[0]!.body).toBe("orphan-line");
    expect(logs[0]!.trace_id).toBeNull();
    expect(logs[0]!.span_id).toBeNull();
  });

  it("honours explicit traceId / spanId overrides", async () => {
    const captured: Array<{ event: unknown }> = [];
    morse._setTransportFactoryForTesting((): BatchTransport => {
      return {
        track(event: unknown): boolean {
          captured.push({ event });
          return true;
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as BatchTransport;
    });

    morse.init({ apiKey: "av_x", endpoint: "https://example.test/api/v1/traces/batch" });

    morse.log("manual", {
      traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
      spanId: "cafebabecafebabecafebabecafebabe",
      severity: "warn",
      serviceName: "my-app",
      attributes: { route: "/healthz" },
    });

    const logs = (captured[0]!.event as { logs: LogRecordPayload[] }).logs;
    expect(logs[0]!.trace_id).toBe("deadbeefdeadbeefdeadbeefdeadbeef");
    expect(logs[0]!.span_id).toBe("cafebabecafebabecafebabecafebabe");
    expect(logs[0]!.severity).toBe("WARN");
    expect(logs[0]!.service_name).toBe("my-app");
    expect(logs[0]!.attributes).toEqual({ route: "/healthz" });
  });
});

describe("log() — non-invasive guarantee", () => {
  it("does not throw when the transport's track() raises", () => {
    morse._setTransportFactoryForTesting((): BatchTransport => {
      return {
        track(): boolean {
          throw new Error("boom");
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as BatchTransport;
    });
    morse.init({ apiKey: "av_x", endpoint: "https://example.test/api/v1/traces/batch" });

    // Should be fully absorbed.
    expect(() => morse.log("hi")).not.toThrow();
  });

  it("absorbs transport rejection on the real BatchTransport (POST fails)", async () => {
    // Use the real BatchTransport with a fetch that always rejects.
    const failingFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    morse._setTransportFactoryForTesting(
      (opts) =>
        new BatchTransport({
          ...opts,
          maxBatchSize: 1,
          fetchImpl: failingFetch,
        }),
    );
    morse.init({ apiKey: "av_x", endpoint: "https://example.test/api/v1/traces/batch" });

    expect(() => morse.log("hi")).not.toThrow();
    // Allow the flush to fire and the rejection to propagate within the
    // transport. The caller-facing flush() also absorbs internal errors.
    await morse.flush();
  });
});

describe("log() — wire routing", () => {
  it("POSTs logs to the derived /api/v1/logs/ingest URL, not the traces endpoint", async () => {
    const { fetch: fetchSpy, calls } = makeFetchSpy();
    morse._setTransportFactoryForTesting(
      (opts) =>
        new BatchTransport({
          ...opts,
          flushIntervalSeconds: 100,
          maxBatchSize: 1,
          fetchImpl: fetchSpy,
        }),
    );
    morse.init({
      apiKey: "av_x",
      endpoint: "https://example.test/api/v1/traces/batch",
    });

    morse.log("hi", { attributes: { k: "v" } });
    await morse.flush();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://example.test/api/v1/logs/ingest");
    const body = calls[0]!.body as { logs: LogRecordPayload[] };
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]!.body).toBe("hi");
    expect(body.logs[0]!.severity).toBe("INFO");
    expect(body.logs[0]!.service_name).toBe("morse-sdk-ts");
    expect(body.logs[0]!.attributes).toEqual({ k: "v" });
  });
});

describe("deriveLogsEndpoint", () => {
  it("replaces the path with /api/v1/logs/ingest", () => {
    expect(deriveLogsEndpoint("https://api.morsehq.dev/api/v1/traces/batch")).toBe(
      "https://api.morsehq.dev/api/v1/logs/ingest",
    );
  });

  it("drops query strings + fragments", () => {
    expect(deriveLogsEndpoint("https://api.morsehq.dev/api/v1/traces/batch?x=1#y")).toBe(
      "https://api.morsehq.dev/api/v1/logs/ingest",
    );
  });

  it("preserves a non-standard port", () => {
    expect(deriveLogsEndpoint("http://localhost:8000/api/v1/traces/batch")).toBe(
      "http://localhost:8000/api/v1/logs/ingest",
    );
  });
});
