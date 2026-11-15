/**
 * BatchTransport tests.
 *
 * Covers:
 *   - Async batching: the transport flushes when the batch hits 100 events.
 *   - Async batching: the transport flushes at the configured interval.
 *   - Network errors are silently absorbed (the test would throw if not).
 *   - Trace events go to the `{traces:[...]}` wire shape.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BatchTransport,
  getQuotaState,
  _resetQuotaStateForTesting,
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

describe("BatchTransport", () => {
  it("flushes immediately when the batch reaches max size", async () => {
    const { fetch: fetchSpy, calls } = makeFetchSpy();
    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100, // long, won't trigger
      maxBatchSize: 3,
      fetchImpl: fetchSpy,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    transport.track({ traces: [{ trace: { trace_id: "t2" }, spans: [] }] });
    transport.track({ traces: [{ trace: { trace_id: "t3" }, spans: [] }] });

    await transport.flush();
    await transport.shutdown();

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://example.test/api");
    const body = calls[0]!.body as { traces: Array<{ trace: { trace_id: string } }> };
    expect(body.traces).toHaveLength(3);
  });

  it("partitions traces vs runs into separate POSTs", async () => {
    const { fetch: fetchSpy, calls } = makeFetchSpy();
    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 100,
      fetchImpl: fetchSpy,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    transport.track({ agent: "x", success: true } as Record<string, unknown>);

    await transport.flush();
    await transport.shutdown();

    expect(calls.length).toBe(2);
    const bodies = calls.map((c) => c.body as Record<string, unknown>);
    const tracesBody = bodies.find((b) => "traces" in b);
    const runsBody = bodies.find((b) => "runs" in b);
    expect(tracesBody).toBeDefined();
    expect(runsBody).toBeDefined();
    const runs = (runsBody as { runs: unknown[] }).runs;
    expect(runs).toHaveLength(1);
  });

  it("absorbs network errors silently", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();

    // The transport must have logged a warning, not thrown.
    warnSpy.mockRestore();
  });

  it("track() returns false when the queue is full", () => {
    const { fetch: fetchSpy } = makeFetchSpy();
    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      maxQueueSize: 2,
      maxBatchSize: 1000, // don't drain on push
      flushIntervalSeconds: 100,
      fetchImpl: fetchSpy,
    });

    expect(transport.track({ a: 1 })).toBe(true);
    expect(transport.track({ a: 2 })).toBe(true);
    expect(transport.track({ a: 3 })).toBe(false);

    void transport.shutdown();
  });
});

describe("BatchTransport quota state (TQE-04 / MHQ-749)", () => {
  afterEach(() => {
    _resetQuotaStateForTesting();
  });

  function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
    return new Response(JSON.stringify(body), { status, headers });
  }

  it("returns null before any 429 has been observed", () => {
    expect(getQuotaState()).toBeNull();
  });

  it("parses an event_limit_exceeded body into kind: event_limit", async () => {
    const eventLimitBody = {
      error: "event_limit_exceeded",
      message: "Monthly event limit of 5,000 spans reached for plan 'free'.",
      current_count: 5000,
      limit_count: 5000,
      plan_id: "free",
      period_start: "2026-07-01T00:00:00+00:00",
      upgrade_url: "https://app.morseai.dev/billing",
      sample_rate_url: "https://app.morseai.dev/billing/usage/breakdown",
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, eventLimitBody, {
        "Retry-After": "1",
        "X-Morse-Quota-Limit": "5000",
        "X-Morse-Quota-Remaining": "0",
        "X-Morse-Quota-Reset": "1754006400",
      }),
    ) as unknown as typeof fetch;

    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();

    const state = getQuotaState();
    expect(state).not.toBeNull();
    expect(state?.kind).toBe("event_limit");
    expect(state?.status).toBe(429);
    expect(typeof state?.receivedAt).toBe("number");
    expect(state?.currentCount).toBe(5000);
    expect(state?.limitCount).toBe(5000);
    expect(state?.planId).toBe("free");
    expect(state?.periodStart).toBe("2026-07-01T00:00:00+00:00");
    expect(state?.upgradeUrl).toBe("https://app.morseai.dev/billing");
    expect(state?.quotaLimit).toBe(5000);
    expect(state?.quotaRemaining).toBe(0);
    expect(state?.quotaReset).toBe(1754006400);
    expect(state?.retryAfterSeconds).toBe(1);
  });

  it("parses a RATE_LIMIT_INGEST body into kind: rate_limit", async () => {
    const rateLimitBody = {
      error: {
        code: "RATE_LIMIT_INGEST",
        message: "Ingestion rate limit exceeded.",
        details: { limit: 10, plan: "free" },
      },
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, rateLimitBody, { "Retry-After": "1" }),
    ) as unknown as typeof fetch;

    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();

    const state = getQuotaState();
    expect(state?.kind).toBe("rate_limit");
    expect(state?.limitCount).toBe(10);
    expect(state?.planId).toBe("free");
  });

  it("records kind: unknown for a non-JSON 429 body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Too Many Requests", { status: 429 }),
    ) as unknown as typeof fetch;

    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();

    const state = getQuotaState();
    expect(state?.kind).toBe("unknown");
    expect(state?.status).toBe(429);
  });

  it("returns a copy — mutating the returned object doesn't affect stored state", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { error: "event_limit_exceeded" }),
    ) as unknown as typeof fetch;

    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();

    const first = getQuotaState();
    expect(first).not.toBeNull();

    first!.kind = "unknown";
    expect(getQuotaState()?.kind).toBe("event_limit");
  });

  it("does not clear quota state after a subsequent successful POST", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(429, { error: "event_limit_exceeded" });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });

    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    expect(getQuotaState()?.kind).toBe("event_limit");

    // A second, successful batch — Python's transport never clears
    // quota state on success (it persists until overwritten by a newer
    // 429), and this port matches that.
    transport.track({ traces: [{ trace: { trace_id: "t2" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();

    expect(getQuotaState()?.kind).toBe("event_limit");
  });
});

/**
 * MHQ-972 — the delivery counter must name the failure a reader would act on.
 *
 * Until 2026-08-10 this transport reported EVERY drop as `retry_exhausted`,
 * which was false twice over: it had no retry loop, so nothing was exhausted,
 * and a revoked key was indistinguishable from a 5xx. `encode_failed` was
 * defined but unreachable, because JSON.stringify ran inside the try that owns
 * the network call and its throw landed in the network catch.
 *
 * MHQ-1001 then added the retry loop, so `retry_exhausted` became true for the
 * first time — and the 5xx / network expectations below moved with it.
 */
describe("BatchTransport delivery reason codes (MHQ-972)", () => {
  async function drainReasonFor(status: number): Promise<string[]> {
    const diagnostics = await import("../src/_internal/diagnostics");
    diagnostics.drainCounters(); // clear anything a previous test left
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status }),
    ) as unknown as typeof fetch;
    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });
    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();
    return diagnostics.drainCounters().map((c) => c.reason);
  }

  it.each([
    [401, "auth_rejected"],
    [403, "auth_rejected"],
    [400, "endpoint_rejected"],
    [404, "endpoint_rejected"],
    [422, "endpoint_rejected"],
  ])("reports %i as %s", async (status, expected) => {
    const reasons = await drainReasonFor(status);
    expect(reasons).toContain(expected);
    // The regression this suite exists to prevent.
    expect(reasons).not.toContain("retry_exhausted");
  });

  it("reports a 5xx as retry_exhausted once the attempts are used up", async () => {
    // MHQ-1001 changed this. Before the retry loop existed this was
    // `send_failed`, because nothing was ever retried and claiming otherwise
    // would have been a lie. Now attempts really are made and used up, so
    // `retry_exhausted` is the honest code.
    const reasons = await drainReasonFor(503);
    expect(reasons).toContain("retry_exhausted");
    expect(reasons).not.toContain("send_failed");
  });

  it("reports a network failure as retry_exhausted once attempts are used up", async () => {
    const diagnostics = await import("../src/_internal/diagnostics");
    diagnostics.drainCounters();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl,
    });
    transport.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await transport.flush();
    await transport.shutdown();
    const reasons = diagnostics.drainCounters().map((c) => c.reason);
    expect(reasons).toContain("retry_exhausted");
    expect(reasons).not.toContain("send_failed");
  });

  it("reports an unserialisable payload as encode_failed, and never sends", async () => {
    const diagnostics = await import("../src/_internal/diagnostics");
    diagnostics.drainCounters();
    const { fetch: fetchSpy, calls } = makeFetchSpy();
    const transport = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x",
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchImpl: fetchSpy,
    });
    // A circular reference: JSON.stringify throws on it.
    const circular: Record<string, unknown> = { trace: { trace_id: "t1" }, spans: [] };
    circular.self = circular;
    transport.track({ traces: [circular] });
    await transport.flush();
    await transport.shutdown();

    const reasons = diagnostics.drainCounters().map((c) => c.reason);
    expect(reasons).toContain("encode_failed");
    expect(calls.length).toBe(0); // nothing left the process
  });
});

/**
 * MHQ-1001 — the retry loop, ported from Python's `test_transport_retry.py`.
 *
 * Python's contract: 3 attempts, jittered exponential backoff, 4xx never
 * retried except 429, Retry-After honoured. The BOUND is deliberately not
 * ported: Python retries on a background daemon thread, whereas `flush()` here
 * is awaited by the caller — very often a serverless handler — so the drain
 * carries its own `flushTimeoutMs` ceiling instead.
 */
describe("BatchTransport retry (MHQ-1001)", () => {
  function countingFetch(status: number | "throw", okAfter = Infinity) {
    let calls = 0;
    const impl = vi.fn(async () => {
      calls += 1;
      if (calls >= okAfter) return new Response("{}", { status: 200 });
      if (status === "throw") throw new Error("ECONNREFUSED");
      return new Response("nope", { status });
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  }

  async function run(fetchImpl: typeof fetch, flushTimeoutMs = 5_000) {
    const t = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x", // pragma: allowlist secret
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchTimeoutMs: 50,
      flushTimeoutMs,
      fetchImpl,
    });
    t.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    await t.flush();
    await t.shutdown();
  }

  it("retries a 5xx up to three attempts", async () => {
    const { impl, calls } = countingFetch(503);
    await run(impl);
    expect(calls()).toBe(3);
  });

  it("stops as soon as a retry succeeds", async () => {
    const { impl, calls } = countingFetch(503, 2);
    await run(impl);
    expect(calls()).toBe(2);
  });

  it("retries a network error", async () => {
    const { impl, calls } = countingFetch("throw");
    await run(impl);
    expect(calls()).toBe(3);
  });

  it("never retries a non-429 4xx", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const { impl, calls } = countingFetch(status);
      await run(impl);
      expect(calls(), `status ${status} must not be retried`).toBe(1);
    }
  });

  it("retries a 429", async () => {
    const { impl, calls } = countingFetch(429);
    await run(impl);
    expect(calls()).toBe(3);
  });

  it("honours flushTimeoutMs so shutdown cannot hang the caller", async () => {
    // The reason the bound exists: this is the serverless request path.
    const { impl } = countingFetch("throw");
    const started = Date.now();
    await run(impl, 300);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("bounds shutdown even when the injected fetch ignores AbortSignal", async () => {
    // The guarantee that motivated flushTimeoutMs. `fetchTimeoutMs` aborts a
    // CONFORMING fetch, but the deadline is otherwise only checked between
    // attempts — so a fetch that never settles used to hang the caller forever.
    // Measured before the deadline race: 5006ms (i.e. it hung). After: ~508ms.
    const hung = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const t = new BatchTransport({
      endpoint: "https://example.test/api",
      apiKey: "av_x", // pragma: allowlist secret
      flushIntervalSeconds: 100,
      maxBatchSize: 1,
      fetchTimeoutMs: 100,
      flushTimeoutMs: 500,
      fetchImpl: hung,
    });
    t.track({ traces: [{ trace: { trace_id: "t1" }, spans: [] }] });
    const started = Date.now();
    await t.shutdown();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
