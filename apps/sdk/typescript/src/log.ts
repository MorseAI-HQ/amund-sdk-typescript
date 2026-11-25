/**
 * Phase 12.5 Tier 1.2 — TypeScript SDK `log()` export.
 *
 * Closes the TS side of Feature #4 "Gap A": before this module, customers
 * using the TS SDK had no way to populate the Logs tab of a trace's
 * Correlation panel without standing up their own OTel collector. The
 * Python SDK already had `morse.log(...)` (AGE-240); this is the
 * cross-language peer.
 *
 * Semantics mirror Python's `morse.log()`
 * (`apps/sdk/python/src/morse/__init__.py:360-411`):
 *
 *   - Default severity: "info" (case-normalised to upper on the wire).
 *   - Default service_name: "morse-sdk-ts" (overridable).
 *   - Auto-reads the active trace_id + span_id from the SDK's existing
 *     `node:async_hooks.AsyncLocalStorage` context (re-uses
 *     `getActiveTraceState()` — the same primitive `run()`/`span()` use).
 *   - Batched: the record is enqueued on the existing `BatchTransport`,
 *     which flushes it to `/api/v1/logs/ingest` (derived from the traces
 *     batch endpoint) on the next tick. NO synchronous fetch per call.
 *   - Internal errors are absorbed via `absorbErrorsSync` so they never
 *     propagate into the customer's logging call. Mirrors the Python
 *     `@absorb_errors` decorator pattern.
 *
 * Wire shape: `{ logs: [{ timestamp, severity, service_name, body,
 * attributes, trace_id, span_id }] }`. See `apps/api/apps/logs/
 * controllers.py:66-134` for the API contract.
 */

import { absorbErrorsSync } from "./_internal/errors";
import { redactValue } from "./_internal/redaction";
import {
  getActiveTraceState,
  getRedactionConfig,
  getTransport,
  type TransportLike,
} from "./_internal/tracing";

/** Log severity — case-insensitive on input, upper-cased on the wire. */
export type LogSeverity = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Options accepted by `log()`. */
export interface LogOptions {
  /** Default: `"info"`. Upper-cased server-side. */
  severity?: LogSeverity;
  /** Free-form structured fields persisted on the record. */
  attributes?: Record<string, unknown>;
  /**
   * Override the auto-detected trace_id. Use only when emitting on
   * behalf of a known external trace (rare).
   */
  traceId?: string;
  /** Override the auto-detected span_id. Same caveat as `traceId`. */
  spanId?: string;
  /** Logical service tag. Default: `"morse-sdk-ts"`. */
  serviceName?: string;
}

const DEFAULT_SERVICE_NAME = "morse-sdk-ts";

/**
 * Lazy-init hook injected by `index.ts`. Allows `log()` to participate
 * in env-driven auto-init (matching the behaviour of `track()` /
 * `record()`) without `log.ts` reaching into the singleton state.
 *
 * @internal
 */
let ensureInitialized: () => void = () => {
  /* default no-op; replaced from index.ts */
};

/** @internal */
export function _setEnsureInitialized(fn: () => void): void {
  ensureInitialized = fn;
}

function logImpl(message: string, options: LogOptions = {}): void {
  // Match Python semantics: env-driven auto-init kicks in if the SDK
  // hasn't been explicitly init()'d yet but AMUND_API_KEY is set.
  ensureInitialized();
  const transport: TransportLike | null = getTransport();
  if (transport === null) {
    // SDK not initialised — silent no-op. Matches Python behaviour
    // (`_ensure_initialized()` short-circuit).
    return;
  }

  // Auto-pull trace + span IDs from the active context. Re-uses the
  // exact same context primitive that `track()` / `run()` / `span()`
  // use, so a `log()` call inside an `await run(...)` callback will
  // see the active trace's IDs.
  let traceId: string | null = options.traceId ?? null;
  let spanId: string | null = options.spanId ?? null;
  if (traceId === null || spanId === null) {
    const state = getActiveTraceState();
    if (state !== null) {
      if (traceId === null) traceId = state.traceId;
      if (spanId === null && state.spanStack.length > 0) {
        spanId = state.spanStack[state.spanStack.length - 1]!.span_id;
      }
    }
  }

  const severity = (options.severity ?? "info").toUpperCase();
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;

  // PII redaction reuses the trace path's allow-list config. Mirrors
  // the Python client's `self._redaction_config.redact_value(payload)`
  // call.
  const config = getRedactionConfig();
  const rawAttributes = options.attributes ?? {};
  const redactedAttributes = config.enabled
    ? (redactValue(rawAttributes, config) as Record<string, unknown>)
    : rawAttributes;
  const redactedBody = config.enabled
    ? (redactValue(String(message), config) as string)
    : String(message);

  const record = {
    timestamp: new Date().toISOString(),
    severity,
    service_name: serviceName,
    body: redactedBody,
    attributes: redactedAttributes,
    trace_id: traceId,
    span_id: spanId,
  };

  transport.track({ logs: [record] });
}

/**
 * Emit a log record correlated to the current trace context.
 *
 * Auto-correlates to the surrounding `morse.run()` /
 * `morse.span()` if one is active. Inside a trace, the record's
 * `trace_id` + `span_id` are filled in from `AsyncLocalStorage`;
 * outside a trace, both fields are `null` and the record is still
 * accepted by the backend (it surfaces in the service-wide Logs view
 * but not on any individual trace's Correlation panel).
 *
 * Non-blocking. Batched alongside trace events on the existing
 * transport — flushes at the SDK's configured interval (default 2s).
 * Internal errors are absorbed; this call never throws.
 *
 * Silent no-op when the SDK isn't initialised (no `AMUND_API_KEY`
 * and no explicit `init()` call).
 *
 * @example
 * ```ts
 * import { init, runTraced, log } from "@amundai/sdk";
 *
 * init({ apiKey: process.env.AMUND_API_KEY });
 *
 * await runTraced({ agentName: "lead-qualifier" }, async () => {
 *   log("starting search", { attributes: { query: "morse" } });
 *   const results = await search();
 *   log("search complete", {
 *     severity: "info",
 *     attributes: { result_count: results.length },
 *   });
 * });
 * ```
 */
export const log = absorbErrorsSync(logImpl, {
  fingerprint: "morse.log",
});
