/**
 * Background batched HTTP transport.
 *
 * Mirrors the Python SDK's `transport.py` semantics:
 *
 *   - Async batching: 2-second flush interval (configurable), 100-event
 *     max batch size (configurable). Whichever fires first triggers a
 *     flush.
 *   - Network failures are silently dropped with a debug log — never
 *     thrown to the caller.
 *   - The caller's thread / event loop is never blocked: `track()`
 *     enqueues and returns immediately.
 *
 * The transport speaks two payload shapes (matching Python):
 *
 *   - V2 trace events:  `{ traces: [{ trace, spans }, ...] }`
 *   - V1 legacy runs:   `{ runs: [{ ... }, ...] }`
 *
 * Wire-format routing checks for a `traces` key on each enqueued event.
 *
 * Browser vs Node:
 *   - Both runtimes ship `fetch` (Node 18+ / all evergreens).
 *   - In Node we can run a `setInterval` and call it a day.
 *   - In the browser the same approach works; we don't currently flush
 *     on `pagehide` / `beforeunload` — Phase 6c spec doesn't require it.
 *     A future change can add `navigator.sendBeacon` for last-gasp delivery.
 */

import {
  recordDrop,
  report,
  setLevel,
  REASON_AUTH_REJECTED,
  REASON_ENCODE_FAILED,
  REASON_ENDPOINT_REJECTED,
  REASON_QUEUE_FULL,
  REASON_QUOTA_REJECTED,
  REASON_RETRY_EXHAUSTED,
  REASON_SEND_FAILED,
  REASON_SHUTDOWN_DROP,
} from "./diagnostics";

// Injected at build time by tsup from package.json — see tsup.config.ts.
// The version is declared in exactly one place (package.json); a copy here
// would drift the moment a release bumped one and not the other, and the
// stale value rides out on the User-Agent and on every span's `sdk_version`.
// `__SDK_VERSION__` is undefined when running straight from source (vitest,
// ts-node), hence the fallback.
declare const __SDK_VERSION__: string | undefined;

export const SDK_VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";

export interface BatchTransportOptions {
  endpoint: string;
  apiKey: string;
  /** Max wait between flushes, in seconds. Default: 2.0. */
  flushIntervalSeconds?: number;
  /** Max events per batch. Default: 100. */
  maxBatchSize?: number;
  /** Max queued events before drop. Default: 10_000. */
  maxQueueSize?: number;
  /** Timeout for the underlying fetch, in ms. Default: 5_000. */
  fetchTimeoutMs?: number;
  /**
   * Ceiling on a caller-awaited `flush()` / `shutdown()`, in ms. Default:
   * 10_000. Retries stop once it elapses, and anything still queued is counted
   * as a drop rather than silently held (MHQ-1001).
   *
   * NOT yet reachable from the public `init()` — that would widen the published
   * SDK contract, which is a founder call. Constructor-only for now, which is
   * still strictly better than the unbounded wait this replaces.
   */
  flushTimeoutMs?: number;
  /**
   * Pluggable fetch implementation. Defaults to `globalThis.fetch`.
   * Useful for tests.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Wire shape for a single log record. Mirrors the Python SDK payload at
 * `apps/sdk/python/src/morse/client.py:191-211` and the backend
 * `SimpleLogsIngestController.ingest` contract
 * (`apps/api/apps/logs/controllers.py:66-134`).
 */
export interface LogRecordPayload {
  timestamp: string;
  severity: string;
  service_name: string;
  body: string;
  attributes: Record<string, unknown>;
  trace_id: string | null;
  span_id: string | null;
}

export type TelemetryEvent =
  | { traces: unknown[] }
  | { logs: LogRecordPayload[] }
  | Record<string, unknown>;

/**
 * Quota / rate-limit state parsed from a 429 batch-POST response.
 *
 * Mirrors Python's `transport.py::BatchTransport._record_quota_state` /
 * `quota_state()` (TQE-04 / MHQ-676) field-for-field, camelCased per this
 * codebase's convention (`received_at` -> `receivedAt`, etc.). Two known
 * body shapes:
 *
 *   - `event_limit_exceeded` (traces controllers) — flat body with
 *     `current_count` / `limit_count` / `plan_id` / `period_start` /
 *     `upgrade_url` / `sample_rate_url`.
 *   - `RATE_LIMIT_INGEST` (ingest rate-limit middleware) — nested
 *     `{ error: { code, message, details: { limit, plan } } }`.
 *
 * Anything else is recorded as `kind: "unknown"` so the state surface
 * still reflects that ingest is throttled even when the body doesn't
 * parse into a known shape.
 */
export interface QuotaState {
  kind: "event_limit" | "rate_limit" | "unknown";
  status: number;
  /** Epoch seconds, matching Python's `time.time()`. */
  receivedAt: number;
  message?: string;
  currentCount?: number;
  limitCount?: number;
  planId?: string;
  periodStart?: string;
  upgradeUrl?: string;
  sampleRateUrl?: string;
  quotaLimit?: number;
  quotaRemaining?: number;
  quotaReset?: number;
  retryAfterSeconds?: number;
}

// `Retry-After` values above this are clamped, mirroring Python's
// `_RETRY_AFTER_CAP_SECONDS` — a background flush loop must never commit
// to reporting minutes-long waits from one batch.
const RETRY_AFTER_CAP_SECONDS = 30.0;

// --- Retry/backoff (MHQ-1001) ----------------------------------------------
//
// Mirrors Python's `transport.py`: 3 attempts, jittered exponential backoff,
// 4xx never retried except 429, Retry-After honoured and capped.
//
// The bound is NOT mirrored, deliberately. Python retries on a background
// daemon thread and its `flush()` polls with a 30s deadline, so the caller is
// insulated. Here `flush()`/`shutdown()` are awaited by the caller, which in
// this SDK is very often a serverless handler (Vercel AI / Next.js) finishing a
// request. A faithful 30s port would put up to ~20s of backoff inside somebody's
// request path, so the drain gets its own, smaller deadline below.
const MAX_SEND_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/** Overall ceiling on a caller-awaited `flush()` / `shutdown()`. */
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

/** Jittered exponential backoff for a 1-based attempt. Mirrors `_backoff_delay`. */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return base * (0.5 + Math.random());
}

/**
 * Which reason a retryable failure ends up reported as.
 *
 * The three are genuinely different and a reader acts on each differently:
 *   - `shutdown_drop`   the process is going away; delivery was never possible
 *   - `send_failed`     one attempt, no retry possible (no budget left)
 *   - `retry_exhausted` attempts were made and used up
 *
 * Keeping `send_failed` reachable matters: MHQ-972 was exactly a reason code
 * with no call site, and adding the retry loop nearly orphaned this one.
 */
function dropReasonFor(attempt: number, closed: boolean, deadline: number): string {
  if (closed) return REASON_SHUTDOWN_DROP;
  if (attempt === 1 && Date.now() >= deadline) return REASON_SEND_FAILED;
  return REASON_RETRY_EXHAUSTED;
}

/**
 * Resolve `promise`, or reject once `deadline` passes — whichever comes first.
 *
 * `fetchTimeoutMs` already aborts a conforming `fetch`, so in the normal case
 * this never fires. It exists because the deadline is otherwise only checked
 * BETWEEN attempts: a `fetchImpl` that ignores `AbortSignal` (a stub, a buggy
 * polyfill) would hang inside a single attempt and the caller would wait
 * forever. Serverless is the motivating case, so the bound has to hold even
 * when the injected fetch misbehaves. The abandoned request may still complete
 * in the background — we cannot cancel it, only stop waiting on it.
 */
function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("morse: flush deadline exceeded")), remaining);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Sleep that resolves early once `deadline` passes, so shutdown can't hang. */
function sleepUntil(ms: number, deadline: number): Promise<void> {
  const remaining = Math.max(0, Math.min(ms, deadline - Date.now()));
  return new Promise((resolve) => setTimeout(resolve, remaining));
}

/**
 * Parse a `Retry-After` header (seconds form only), capped.
 *
 * Mirrors Python's `transport.py::_parse_retry_after`. HTTP-date form
 * isn't worth supporting — Morse's own 429s always use the seconds form.
 * Unparseable / negative values return `null`.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, RETRY_AFTER_CAP_SECONDS);
}

// Module-level, matching the `lastTrace` test-introspection pattern in
// `_internal/tracing.ts` — the latest quota/rate-limit state observed on
// a 429 response, exposed via `quotaState()` / `morse.quotaState()`. Not
// cleared on a subsequent successful POST (mirrors Python: it persists
// until overwritten by a newer 429, so a host app can see "quota was
// exceeded recently" even after the queue drains — see
// `test_429_recovers_when_retry_succeeds` in the Python test suite,
// which only asserts no drop-warning, never that state was cleared).
let quotaState: QuotaState | null = null;

/**
 * Latest quota/rate-limit state observed on a 429, or `null` if none has
 * been observed yet. Returns a shallow copy — callers can't mutate
 * transport-internal state. Mirrors Python's `BatchTransport.quota_state()`.
 *
 * @internal
 */
export function getQuotaState(): QuotaState | null {
  return quotaState ? { ...quotaState } : null;
}

/**
 * Reset the module-level quota state between test files/cases.
 *
 * @internal
 */
export function _resetQuotaStateForTesting(): void {
  quotaState = null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberFromHeader(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a 429 response into the module-level quota state. Never throws —
 * defensively parses two known body shapes (see `QuotaState`), falling
 * back to `kind: "unknown"` for anything else. Mirrors Python's
 * `_record_quota_state`.
 */
async function recordQuotaState(resp: Response): Promise<void> {
  try {
    const state: QuotaState = {
      kind: "unknown",
      status: 429,
      receivedAt: Date.now() / 1000,
    };

    let data: unknown = null;
    try {
      data = await resp.clone().json();
    } catch {
      data = null;
    }

    if (data !== null && typeof data === "object") {
      const body = data as Record<string, unknown>;
      const err = body.error;
      if (err === "event_limit_exceeded") {
        state.kind = "event_limit";
        state.message = asString(body.message);
        state.currentCount = asNumber(body.current_count);
        state.limitCount = asNumber(body.limit_count);
        state.planId = asString(body.plan_id);
        state.periodStart = asString(body.period_start);
        state.upgradeUrl = asString(body.upgrade_url);
        state.sampleRateUrl = asString(body.sample_rate_url);
      } else if (
        err !== null &&
        typeof err === "object" &&
        (err as Record<string, unknown>).code === "RATE_LIMIT_INGEST"
      ) {
        const errObj = err as Record<string, unknown>;
        const details =
          errObj.details !== null && typeof errObj.details === "object"
            ? (errObj.details as Record<string, unknown>)
            : {};
        state.kind = "rate_limit";
        state.message = asString(errObj.message);
        state.limitCount = asNumber(details.limit);
        state.planId = asString(details.plan);
      }
    }

    // TQE-05 headers, emitted by the server on every ingest response.
    const quotaLimit = numberFromHeader(resp.headers.get("X-Morse-Quota-Limit"));
    if (quotaLimit !== undefined) state.quotaLimit = quotaLimit;
    const quotaRemaining = numberFromHeader(resp.headers.get("X-Morse-Quota-Remaining"));
    if (quotaRemaining !== undefined) state.quotaRemaining = quotaRemaining;
    const quotaReset = numberFromHeader(resp.headers.get("X-Morse-Quota-Reset"));
    if (quotaReset !== undefined) state.quotaReset = quotaReset;
    const retryAfter = parseRetryAfter(resp.headers.get("Retry-After"));
    if (retryAfter !== null) state.retryAfterSeconds = retryAfter;

    quotaState = state;
  } catch {
    // Never let state capture break the send path.
  }
}

export class BatchTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly flushIntervalSeconds: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly fetchTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private queue: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private closed = false;
  private inflight: Promise<void> | null = null;

  constructor(opts: BatchTransportOptions) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.flushIntervalSeconds = opts.flushIntervalSeconds ?? 2.0;
    this.maxBatchSize = opts.maxBatchSize ?? 100;
    this.maxQueueSize = opts.maxQueueSize ?? 10_000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 5_000;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

    // setInterval keeps the Node event loop alive. We mark it `unref`
    // when available so a process-exit isn't blocked by a quiet flusher.
    const intervalMs = Math.max(50, Math.round(this.flushIntervalSeconds * 1000));
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = this.timer as any;
    if (typeof t?.unref === "function") {
      t.unref();
    }
  }

  /** Enqueue an event. Non-blocking. Returns false if the queue is full. */
  track(event: TelemetryEvent): boolean {
    if (this.closed) {
      recordDrop(REASON_SHUTDOWN_DROP, "trace");
      return false;
    }
    if (this.queue.length >= this.maxQueueSize) {
      // SDKDIAG-09: previously a bare `return false` — sustained telemetry loss
      // was invisible to both us and the customer. Now counted and logged.
      recordDrop(REASON_QUEUE_FULL, "trace");
      return false;
    }
    this.queue.push(event);
    if (this.queue.length >= this.maxBatchSize) {
      void this.tick();
    }
    return true;
  }

  /** Block until all currently-queued events have been sent. */
  async flush(): Promise<void> {
    // Drain in one-batch chunks until empty, then await the in-flight send.
    while (this.queue.length > 0) {
      await this.tick();
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        // Swallow — caller observes nothing.
      }
    }
  }

  /** Stop the background timer. After this call, `track()` is a no-op. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async tick(): Promise<void> {
    if (this.flushing) return;
    if (this.queue.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.queue.splice(0, this.maxBatchSize);
      this.inflight = this.sendBatch(batch);
      await this.inflight;
      this.inflight = null;
    } finally {
      this.flushing = false;
    }
  }

  private async sendBatch(batch: TelemetryEvent[]): Promise<void> {
    const traceEntries: unknown[] = [];
    const runEntries: Record<string, unknown>[] = [];
    const logEntries: LogRecordPayload[] = [];
    for (const event of batch) {
      if (typeof event === "object" && event !== null && "traces" in event) {
        const e = event as { traces: unknown[] };
        if (Array.isArray(e.traces)) {
          traceEntries.push(...e.traces);
        }
      } else if (typeof event === "object" && event !== null && "logs" in event) {
        const e = event as { logs: LogRecordPayload[] };
        if (Array.isArray(e.logs)) {
          logEntries.push(...e.logs);
        }
      } else {
        runEntries.push(event as Record<string, unknown>);
      }
    }
    if (traceEntries.length > 0) {
      await this.post(this.endpoint, { traces: traceEntries });
    }
    if (runEntries.length > 0) {
      await this.post(this.endpoint, { runs: runEntries });
    }
    if (logEntries.length > 0) {
      // Phase 12.5 Tier 1.2 — logs go to a derived `/api/v1/logs/ingest`
      // endpoint on the same host as the traces batch URL. Mirrors the
      // Python SDK's URL derivation in
      // `apps/sdk/python/src/morse/client.py:187-190`.
      await this.post(deriveLogsEndpoint(this.endpoint), { logs: logEntries });
    }
  }

  private async post(
    url: string,
    payload: Record<string, unknown>,
    deadline: number = Date.now() + this.flushTimeoutMs,
  ): Promise<void> {
    // MHQ-972: serialise BEFORE the try that owns the network call. Inside it,
    // a JSON.stringify throw (a circular ref, a BigInt, a hostile toJSON) fell
    // into the network catch and was counted as a transport failure — so the
    // one reason code that names a payload bug had no reachable call site.
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch (err) {
      recordDrop(REASON_ENCODE_FAILED, categoryOf(payload), countPayloadEntries(payload));
      report(err, {
        fingerprint: "morse.transport.post.encode",
        extra: { endpoint_host: hostnameOf(url), sdk_version: SDK_VERSION },
      });
      return;
    }

    const droppedCount = countPayloadEntries(payload);
    const droppedCategory = categoryOf(payload);

    // MHQ-1001: 3 attempts, jittered backoff, 4xx never retried except 429.
    // Every `return` below is a terminal outcome; `continue` is the only path
    // that retries, and it always checks the deadline first.
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      const lastAttempt = attempt >= MAX_SEND_ATTEMPTS;
      const outOfTime = Date.now() >= deadline;
      if (outOfTime && attempt > 1) {
        // The drain ran out of budget mid-retry. Report it as exhausted rather
        // than send_failed: attempts WERE made, we just stopped early.
        recordDrop(REASON_RETRY_EXHAUSTED, droppedCategory, droppedCount);
        return;
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
      try {
        const resp = await withDeadline(
          this.fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
              "User-Agent": `morse-typescript/${SDK_VERSION}`,
            },
            body,
            signal: controller.signal,
          }),
          deadline,
        );
        // SDKDIAG-05: the server pushes the SDK's self-reporting verbosity on a
        // response we are already receiving — no config round-trip.
        setLevel(resp.headers.get("X-Morse-Diagnostics"));

        if (resp.ok) return;

        // Order matters: recordQuotaState reads `resp.clone().json()`, and a
        // clone cannot be taken once the body has been consumed. Draining the
        // snippet first silently degrades every 429 to `kind: "unknown"` — which
        // is exactly what four quota-state tests caught when this was reordered.
        if (resp.status === 429) await recordQuotaState(resp);

        // Drain a few hundred chars of the body for diagnostics.
        let bodySnippet = "";
        try {
          bodySnippet = (await resp.text()).slice(0, 200);
        } catch {
          // ignore
        }
        report(new Error(`morse: batch POST returned ${resp.status} ${bodySnippet}`), {
          fingerprint: "morse.transport.post.non_2xx",
          extra: { endpoint_host: hostnameOf(url), sdk_version: SDK_VERSION },
        });

        if (resp.status === 429) {
          if (lastAttempt) {
            recordDrop(REASON_QUOTA_REJECTED, droppedCategory, droppedCount);
            return;
          }
          const retryAfter = parseRetryAfter(resp.headers.get("Retry-After"));
          await sleepUntil((retryAfter ?? 0) * 1000 + backoffDelayMs(attempt), deadline);
          continue;
        }

        if (resp.status < 500) {
          // Non-429 4xx: retrying cannot help. WHY it cannot differs, and the
          // remedies are unrelated (MHQ-971).
          recordDrop(
            resp.status === 401 || resp.status === 403
              ? REASON_AUTH_REJECTED
              : REASON_ENDPOINT_REJECTED,
            droppedCategory,
            droppedCount,
          );
          return;
        }

        // 5xx — retryable.
        if (lastAttempt || this.closed || Date.now() >= deadline) {
          recordDrop(dropReasonFor(attempt, this.closed, deadline), droppedCategory, droppedCount);
          return;
        }
        await sleepUntil(backoffDelayMs(attempt), deadline);
        continue;
      } catch (err) {
        // Network error / abort / timeout — retryable, same as Python.
        report(err, {
          fingerprint: "morse.transport.post.network",
          extra: { endpoint_host: hostnameOf(url), sdk_version: SDK_VERSION },
        });
        if (lastAttempt || this.closed || Date.now() >= deadline) {
          recordDrop(dropReasonFor(attempt, this.closed, deadline), droppedCategory, droppedCount);
          return;
        }
        await sleepUntil(backoffDelayMs(attempt), deadline);
        continue;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid>";
  }
}

/**
 * Derive the logs ingest URL from the traces batch endpoint. Mirrors the
 * Python SDK helper: replace the path with `/api/v1/logs/ingest` and drop
 * any query/fragment.
 *
 * Exported for tests. Customer code should not call this directly.
 *
 * @internal
 */
export function deriveLogsEndpoint(tracesEndpoint: string): string {
  try {
    const u = new URL(tracesEndpoint);
    u.pathname = "/api/v1/logs/ingest";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // Fall back to a string replace on the most common shape.
    return tracesEndpoint.replace(/\/api\/v1\/.*$/, "/api/v1/logs/ingest");
  }
}

/** How many telemetry entries a failed POST just cost the customer. */
function countPayloadEntries(payload: Record<string, unknown>): number {
  let total = 0;
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) total += value.length;
  }
  return total || 1;
}

/** Which counter category a payload belongs to (SDKDIAG-09). */
function categoryOf(payload: Record<string, unknown>): string {
  if ("traces" in payload) return "trace";
  if ("logs" in payload) return "log";
  return "record";
}
