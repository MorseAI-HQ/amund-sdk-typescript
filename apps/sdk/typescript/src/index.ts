/**
 * `@morsehq-dev/sdk` — TypeScript SDK for Morse observability.
 *
 * V2 module-level singleton API:
 *
 * ```ts
 * import * as morse from "@morsehq-dev/sdk";
 *
 * // Three-step zero-setup integration:
 * //   1. Generate an API key in the Morse dashboard.
 * //   2. npm install @morsehq-dev/sdk
 * //   3. Set MORSE_API_KEY in your environment.
 *
 * morse.track({ agentId: "lead-qualifier", runData: { success: true } });
 *
 * // Or call init() explicitly to override env-var resolution:
 * morse.init({
 *   apiKey: "mhq_xxx", // pragma: allowlist secret — placeholder, not a key
 *   endpoint: "https://api.morsehq.dev/api/v1/traces/batch",
 *   flushIntervalSeconds: 2,
 * });
 * ```
 *
 * Non-invasive guarantee: every public function is wrapped with
 * `absorbErrors`. Telemetry never throws back at the caller; internal
 * errors are reported out-of-band to Morse's own diagnostics endpoint.
 *
 * The internal `BatchTransport` and `TraceState` types back the singleton
 * but are NOT part of the public API. Customers should never reach into
 * the `_internal` directory.
 */

import {
  installAdapters as _installAdapters,
  _resetForTesting as _resetAutoDetectForTesting,
} from "./_internal/auto-detect";
import { absorbErrorsAsync, absorbErrorsSync } from "./_internal/errors";
import {
  DEFAULT_ENDPOINT,
  getApiKey as readApiKeyFromEnv,
  getEndpoint as readEndpointFromEnv,
  getFlushIntervalSeconds,
  getInternalSource as readInternalSourceFromEnv,
  getMaxBatchSize,
  getMaxFieldBytes,
  getMaxQueueSize,
  getSampleRate,
  isDisabled as readIsDisabled,
  isValidInternalSource,
} from "./_internal/env";
import { maybeEnableInfraCaptureFromEnv } from "./_internal/infra-capture";
import { getEngine as getOtelEngine } from "./_internal/otel-provider";
import {
  buildRedactionConfig,
  type RedactionConfig,
  type RedactionOptions,
  redactValue,
} from "./_internal/redaction";
import {
  BatchTransport,
  SDK_VERSION,
  type TelemetryEvent,
  getQuotaState as _getQuotaState,
  _resetQuotaStateForTesting,
  type QuotaState,
} from "./_internal/transport";
import {
  getActiveTraceState as _getActiveTraceState,
  getLastTrace as _getLastTrace,
  runAsync as _runAsync,
  runSync as _runSync,
  sendTrace as _sendTrace,
  setContext as _setContext,
  setOutcome as _setOutcome,
  setRedactionConfig,
  setSource as _setSource,
  setTransport,
  startSpan as _startSpan,
  type RunHandle,
  type RunOptions,
  type SpanHandle,
  type SpanOptions,
  spanAsync as _spanAsync,
  spanSync as _spanSync,
  _resetForTesting as _resetTracingForTesting,
} from "./_internal/tracing";
import {
  report,
  setDiagnosticsClientConfig,
  flushOnce as flushDiagnosticsOnce,
  _resetForTesting as _resetDiagnosticsForTesting,
} from "./_internal/diagnostics";
import { _setEnsureInitialized as _setLogEnsureInitialized } from "./log";
import {
  buildTraceEntry,
  generateSpanId,
  generateTraceId,
  nowIso,
  SpanType,
  type SpanData,
  type TraceFields,
} from "./_internal/spans";

export type { SpanData, SpanType, SpanStatus, ContextSegment } from "./_internal/spans";
export type { RunHandle, RunOptions, SpanHandle, SpanOptions };
export type { QuotaState };
export type { RedactionOptions, RedactionConfig } from "./_internal/redaction";
export {
  extractTraceparent,
  formatTraceparent,
  injectTraceparent,
  injectIntoRequestInit,
  W3C_TRACEPARENT_HEADER,
} from "./propagation";
export {
  extractAnthropicSegments,
  instrumentAnthropic,
  isAnthropicWrapped,
  uninstallAnthropic,
  wrapAnthropic,
  MAX_SEGMENT_CONTENT_BYTES,
} from "./anthropic";
export type {
  AnthropicClientLike,
  AnthropicContentBlockParam,
  AnthropicMessageCreateParams,
  AnthropicMessageParam,
  AnthropicMessageResponse,
  AnthropicTextBlockParam,
  AnthropicToolParam,
  AnthropicToolResultBlockParam,
  AnthropicToolUseBlockParam,
  AnthropicUsage,
  InstrumentAnthropicOptions,
} from "./anthropic";
export { log } from "./log";
export type { LogOptions, LogSeverity } from "./log";

export const version = SDK_VERSION;

/* ------------------------------------------------------------------------ */
/*  Public types                                                             */
/* ------------------------------------------------------------------------ */

/** Options accepted by `init()`. Mirrors Python's `init(...)` kwargs. */
export interface InitOptions {
  /** API key (starts with "mhq_"). Required if no `MORSE_API_KEY` env var. */
  apiKey?: string;
  /** Full ingestion URL. Defaults to the production Railway endpoint. */
  endpoint?: string;
  /** Seconds between batch flushes. Default: 2. */
  flushIntervalSeconds?: number;
  /**
   * Client-side PII redaction. Default-on with the canonical eight-pattern
   * catalogue. Set `enabled: false` to opt out (the server-side mandatory
   * floor still applies). Mandatory patterns (`api_key_prefixed`, `jwt`,
   * `credit_card`, `ssn_us`) cannot be added to `disabledPatterns` —
   * `init()` throws on that.
   */
  redaction?: RedactionOptions;
  /**
   * INTERNAL USE ONLY — resource-level source label for Morse's own
   * dogfood emitters. Mirrors the Python SDK's `init(source=...)` kwarg
   * (PR #90). Accepted values: `"copilot" | "investigator" | "refagent"
   * | "ui-bot"`. Any other value (including misspellings) is silently
   * dropped — falls back to the `MORSE_INTERNAL_SOURCE` env var.
   * Customers should not set this.
   */
  source?: string;
}

/** Single agent-run payload accepted by `track()`. */
export interface TrackOptions {
  /** User-defined agent name (e.g., "lead-qualifier"). */
  agentId: string;
  /** Run-data dict. Shape mirrors backend Run model. */
  runData: Record<string, unknown>;
}

/** High-level outcome shape accepted by `record()` (V1 ergonomic API). */
export interface RunRecord {
  agent: string;
  success?: boolean;
  outcome?: string;
  cost?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  status?: "completed" | "failed" | "timed_out";
}

/* ------------------------------------------------------------------------ */
/*  Module-level singleton state                                             */
/* ------------------------------------------------------------------------ */

interface SingletonState {
  apiKey: string;
  endpoint: string;
  transport: BatchTransport;
  redaction: RedactionConfig;
}

let singleton: SingletonState | null = null;
let transportFactory: (opts: {
  apiKey: string;
  endpoint: string;
  flushIntervalSeconds: number;
}) => BatchTransport = (opts) => new BatchTransport(opts);

let noApiKeyWarningEmitted = false;
let lastLoggedEndpoint: string | null = null;

function logger(level: "info" | "warn", message: string): void {
  const out = level === "warn" ? console.warn : console.info;
  out.call(console, message);
}

function logDestinationOnce(endpoint: string): void {
  if (endpoint === lastLoggedEndpoint) return;
  lastLoggedEndpoint = endpoint;
  logger(
    "info",
    `morse: Morse SDK initialized — sending to ${endpoint} (sdk version ${SDK_VERSION})`,
  );
}

function resolveEndpoint(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = readEndpointFromEnv();
  if (fromEnv) return fromEnv;
  return DEFAULT_ENDPOINT;
}

const OTLP_TRACES_PATH = "/api/v1/otlp/v1/traces";

/**
 * Derive the OTLP ingest URL from the legacy JSON traces batch URL. Keeps
 * host/scheme; replaces the path — mirrors the Python SDK's
 * `client.py::_derive_otlp_endpoint` and this file's own
 * `transport.ts::deriveLogsEndpoint`.
 */
function deriveOtlpEndpoint(tracesEndpoint: string): string {
  try {
    const u = new URL(tracesEndpoint);
    u.pathname = OTLP_TRACES_PATH;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return tracesEndpoint.replace(/\/api\/v1\/.*$/, OTLP_TRACES_PATH);
  }
}

function buildSingleton(opts: InitOptions, redaction: RedactionConfig): SingletonState | null {
  if (readIsDisabled()) {
    return null;
  }
  const apiKey = opts.apiKey ?? readApiKeyFromEnv();
  if (!apiKey) {
    if (!noApiKeyWarningEmitted) {
      logger(
        "warn",
        "morse: not initialized — set MORSE_API_KEY or call morse.init({ apiKey }) (this warning prints once per process; SDK calls are silent no-ops)",
      );
      noApiKeyWarningEmitted = true;
    }
    return null;
  }
  const endpoint = resolveEndpoint(opts.endpoint);
  const flushIntervalSeconds = opts.flushIntervalSeconds ?? getFlushIntervalSeconds();
  const transport = transportFactory({ apiKey, endpoint, flushIntervalSeconds });
  setTransport(transport);
  setRedactionConfig(redaction);
  // MHQ-927: diagnostics resolves its own target and cannot see this config
  // otherwise — env-only resolution silently dropped every diagnostic for
  // consumers who call init({ apiKey, endpoint }) without env vars.
  setDiagnosticsClientConfig({ apiKey, endpoint });
  // Resolve the internal source label: explicit kwarg wins, then env.
  // Invalid values are silently dropped so a typo never tags customer
  // data as dogfood.
  const explicitSource = isValidInternalSource(opts.source) ? opts.source! : undefined;
  const resolvedSource = explicitSource ?? readInternalSourceFromEnv() ?? null;
  _setSource(resolvedSource);
  logDestinationOnce(endpoint);

  // MHQ-482: run()/span()/runTraced()'s real emission pipeline — real OTel
  // spans over OTLP protobuf+gzip. Configured unconditionally (even under
  // MORSE_LEGACY_TRANSPORT=1) so the engine is ready if the flag flips at
  // runtime; the flag only affects which pipeline `tracing.ts::sendTrace()`
  // feeds. Mirrors the Python SDK's `_Client.__init__`.
  try {
    getOtelEngine().configure({
      endpoint: deriveOtlpEndpoint(endpoint),
      apiKey,
      sampleRate: getSampleRate(),
      scheduleDelayMillis: flushIntervalSeconds * 1000,
      maxQueueSize: getMaxQueueSize(),
      maxExportBatchSize: getMaxBatchSize(),
      maxFieldBytes: getMaxFieldBytes(),
      // 10s (not the exporter's un-overridden 30s ceiling): a genuine
      // network blip still gets several retries with backoff; a fully dead
      // endpoint fails within a bounded, shutdown-friendly window instead
      // of the library's full 30s ceiling. Mirrors the Python SDK.
      timeoutMillis: 10_000,
      redactionConfig: redaction,
    });
  } catch (err) {
    report(err, { fingerprint: "morse.otel_provider.configure" });
  }

  // MHQ-482: zero-config adapter auto-detect (mirrors Python's
  // `auto_detect.install_adapters()` call in `_ensure_initialized` /
  // `_init_impl`). Fire-and-forget — telemetry setup must never block or
  // throw back into the customer's init() / first SDK call. Runs AFTER the
  // OTel engine above is configured so any span an auto-installed adapter
  // emits immediately has a working pipeline to flow through.
  void _installAdapters().catch(() => {
    // installAdapters() already absorbs adapter-level failures; this is a
    // defensive backstop so a totally unexpected rejection never surfaces.
  });

  // INFRACAP-01: db / http / queue auto-capture, ON by default and only ever
  // recording inside an active trace (opt out with MORSE_CAPTURE_INFRA=0, or
  // MORSE_CAPTURE_DB / _HTTP / _QUEUE=0). Mirrors the Python SDK's
  // `infra_capture.py::maybe_enable_from_env`. MUST run after
  // `getOtelEngine().configure()` above — instrumentation registration needs
  // the `NodeTracerProvider` that call just built. Never throws.
  maybeEnableInfraCaptureFromEnv({ endpoint });

  return { apiKey, endpoint, transport, redaction };
}

function ensureInitialized(): SingletonState | null {
  if (readIsDisabled()) return null;
  if (singleton !== null) return singleton;
  // Lazy default-init: defaults are safe (default-on redaction).
  singleton = buildSingleton({}, buildRedactionConfig());
  return singleton;
}

// Wire the lazy-init hook into log.ts so `log()` participates in the
// same env-driven auto-init flow as `track()` / `record()`. Discards
// the return value — log.ts only needs the side-effect of populating
// the module-level singleton + transport.
_setLogEnsureInitialized(() => {
  ensureInitialized();
});

/* ------------------------------------------------------------------------ */
/*  Public API — wrapped at the module surface                               */
/* ------------------------------------------------------------------------ */

/**
 * Initialize the Morse SDK singleton. Call once at application
 * startup. After this call, `track()`, `batchTrack()`, `run()`, and
 * `flush()` are wired up to the configured endpoint.
 *
 * `endpoint` is optional — when omitted, the SDK resolves in this order:
 *   1. `MORSE_ENDPOINT` env var (if set)
 *   2. The default Railway production URL.
 *
 * `MORSE_DISABLED=1` overrides everything: `init()` is a no-op.
 *
 * Calling `init()` a second time replaces the singleton — the previous
 * transport is shut down cleanly and a new one is constructed.
 *
 * Validation errors (e.g., disabling a mandatory redaction pattern, an
 * uncompilable extra pattern) are deliberately NOT absorbed — they
 * propagate as `Error`s so the developer sees the misconfiguration at
 * application startup. All other errors raised from internal SDK paths
 * are absorbed via the per-call wrappers downstream.
 */
export function init(options: InitOptions = {}): void {
  if (readIsDisabled()) {
    logger("info", "morse: MORSE_DISABLED=1 — SDK is a no-op");
    return;
  }
  // Validate redaction options FIRST — must throw before we mutate any
  // singleton state, so a misconfigured init leaves the previous client
  // intact and the spec scenario "no Client is constructed" holds.
  const redaction = buildRedactionConfig(options.redaction);

  try {
    if (singleton !== null) {
      void singleton.transport.shutdown();
      singleton = null;
    }
    singleton = buildSingleton(options, redaction);
  } catch (err) {
    report(err, { fingerprint: "morse.init" });
  }
}

/**
 * Submit a single agent run to the ingestion endpoint. Non-blocking;
 * returns immediately. Silently no-ops if the SDK isn't initialised.
 */
export const track = absorbErrorsSync(
  (options: TrackOptions): void => {
    const state = ensureInitialized();
    if (!state) return;
    const payload = {
      agent_id: options.agentId,
      ...options.runData,
    };
    const redacted = redactValue(payload, state.redaction) as TelemetryEvent;
    state.transport.track(redacted);
  },
  { fingerprint: "morse.track" },
);

/** Submit multiple agent runs in bulk. Silently no-ops if uninitialised. */
export const batchTrack = absorbErrorsSync(
  (runs: Array<Record<string, unknown>>): void => {
    const state = ensureInitialized();
    if (!state) return;
    for (const run of runs) {
      const redacted = redactValue(run, state.redaction) as TelemetryEvent;
      state.transport.track(redacted);
    }
  },
  { fingerprint: "morse.batch_track" },
);

/**
 * High-level convenience: record an agent outcome with named fields.
 *
 * Builds a synthetic single-span `agent`-type trace and submits it through
 * the same `traces`-shaped emission path `run()`/`span()` use (MHQ-746) —
 * mirrors Python's `client.py::record()`. The live dev-api backend has no
 * `runs` ingest route; sending through `state.transport.track()` (the
 * shape `track()`/`batchTrack()` still use, matching Python's equally
 * unmigrated `track()`/`batch_track()`) 422s silently. See MHQ-746.
 */
export const record = absorbErrorsSync(
  (rec: RunRecord): void => {
    const state = ensureInitialized();
    if (!state) return;

    const traceId = generateTraceId();
    const now = nowIso();
    const resolvedStatus = rec.errorMessage ? "failed" : (rec.status ?? "completed");

    const span: SpanData = {
      trace_id: traceId,
      span_id: generateSpanId(),
      type: SpanType.AGENT,
      name: rec.agent,
      started_at: now,
      ended_at: now,
      status: resolvedStatus,
      duration_ms: rec.durationMs,
      model: rec.model,
      input_tokens: rec.inputTokens,
      output_tokens: rec.outputTokens,
      total_tokens: rec.totalTokens,
      cost_usd: rec.cost,
      error_message: rec.errorMessage,
      metadata: rec.metadata,
    };

    const traceFields: TraceFields = {
      trace_id: traceId,
      agent: rec.agent,
      status: resolvedStatus,
      started_at: now,
      ended_at: now,
      duration_ms: rec.durationMs,
      error_message: rec.errorMessage,
      success: rec.success,
      outcome: rec.outcome,
    };

    const entry = buildTraceEntry(traceFields, [span]);
    const redacted = redactValue(entry, state.redaction) as {
      trace: Record<string, unknown>;
      spans: Record<string, unknown>[];
    };
    _sendTrace(redacted);
  },
  { fingerprint: "morse.record" },
);

/**
 * Open a traced agent run, executing `fn` inside the trace context.
 * Mirrors Python's `morse.run(...)` context manager.
 *
 * Two overloads are supported:
 *   - `run(name, fn)` — quick form with default options.
 *   - `run({ agentName, incomingTraceparent }, fn)` — full options.
 *
 * Async callers receive a Promise; sync callers receive the value
 * directly. The function's return value is forwarded to the caller.
 */
export function run<T>(name: string, fn: (handle: RunHandle) => T): T | undefined;
export function run<T>(options: RunOptions, fn: (handle: RunHandle) => T): T | undefined;
export function run<T>(
  nameOrOpts: string | RunOptions,
  fn: (handle: RunHandle) => T,
): T | undefined {
  const opts = typeof nameOrOpts === "string" ? { agentName: nameOrOpts } : nameOrOpts;
  // Make sure the SDK is initialised so spans get sent. Failure to init
  // is fine — `_runSync` records to `lastTrace` regardless, useful for tests.
  ensureInitialized();
  // We can't reliably detect async vs sync up front in TypeScript, so we
  // route through `_runSync` and, if the user's `fn` returns a promise,
  // the wrapping trace ends synchronously after the promise is created.
  // For correct async lifecycle, callers should use `runTraced` instead
  // (it awaits the promise inside the `als.run` scope so the trace
  // closes when the promise resolves).
  return _runSync(opts, fn);
}

/** Async variant of `run` — exported for callers who want explicit typing. */
export function runTraced<T>(
  options: RunOptions,
  fn: (handle: RunHandle) => Promise<T>,
): Promise<T | undefined> {
  ensureInitialized();
  return _runAsync(options, fn);
}

/**
 * Attach cost-attribution dimensions to the active trace (MHQ-751). Call
 * once per request (e.g. in middleware) to propagate `customerId`,
 * `feature`, `env`, `team`, etc. to all child spans downstream. Values are
 * coerced to strings. No-op outside an active trace — never throws.
 * Mirrors Python's `morse_ai.set_context(**dims)`.
 */
export function setContext(dims: Record<string, unknown>): void {
  _setContext(dims);
}

/**
 * Declare the outcome of the active trace — success plus an optional label.
 * Morse never guesses one: a trace without a declared outcome is stored with
 * `success` unset; a throw records `success: false`. No-op
 * outside an active trace. Mirrors Python's `morse_ai.set_outcome()`.
 */
export function setOutcome(success: boolean, outcome?: string): void {
  _setOutcome(success, outcome);
}

/** Start a child span under the active trace. Returns null if no trace. */
export function startSpan(options: SpanOptions): SpanHandle | null {
  return _startSpan(options);
}

/** Run `fn` inside a child span. No-op if no trace is active. */
export function span<T>(options: SpanOptions, fn: (handle: SpanHandle | null) => T): T {
  return _spanSync(options, fn);
}

/** Async variant of `span`. */
export function spanAsync<T>(
  options: SpanOptions,
  fn: (handle: SpanHandle | null) => Promise<T>,
): Promise<T> {
  return _spanAsync(options, fn);
}

/** Block until all queued events have been sent. Silent on uninit / errors. */
export const flush = absorbErrorsAsync(
  async (): Promise<void> => {
    if (singleton !== null) {
      await singleton.transport.flush();
      await getOtelEngine().flush();
    }
  },
  { fingerprint: "morse.flush" },
);

/**
 * Latest ingest quota / rate-limit state observed by the SDK, or `null`.
 *
 * TQE-04 (MHQ-676/MHQ-749): when the Morse backend answers a telemetry
 * batch with HTTP 429 — the monthly event limit (`event_limit_exceeded`)
 * or the per-second ingest rate limit (`RATE_LIMIT_INGEST`) — the
 * transport parses the response and stores it. This function exposes
 * that state so host applications can alert on quota exhaustion instead
 * of discovering it from missing telemetry. Mirrors Python's
 * `morse_ai.quota_state()`.
 *
 * Returns `null` when the SDK is uninitialized or no 429 has been
 * observed. The object includes at least `kind` (`"event_limit"`,
 * `"rate_limit"`, or `"unknown"`), `status`, and `receivedAt` (epoch
 * seconds); event-limit states add `currentCount` / `limitCount` /
 * `planId` / `periodStart` / `upgradeUrl`.
 */
export const quotaState = absorbErrorsSync(
  (): QuotaState | null => {
    if (singleton === null) return null;
    return _getQuotaState();
  },
  { fingerprint: "morse.quota_state" },
);

/** Flush and stop the background transport. Call on app exit. */
export const shutdown = absorbErrorsAsync(
  async (): Promise<void> => {
    if (singleton !== null) {
      await singleton.transport.shutdown();
      await getOtelEngine().flush();
      getOtelEngine().shutdown();
      // MHQ-927: diagnostics has its OWN buffer and timer, deliberately
      // separate from the transport so a diagnostic storm can never evict
      // customer telemetry. The timer fires every 5s and is `unref()`d so it
      // cannot hold the event loop open — which means a short-lived process
      // (a script, a CLI, a serverless invocation, every driver in the
      // adapter matrix) exits with its buffer unsent. Nothing else drains it,
      // so those diagnostics were simply lost.
      //
      // Drained AFTER the transport and OTel shutdown above: those can
      // themselves report internal errors, and this is the last chance to
      // send them.
      await flushDiagnosticsOnce();
      singleton = null;
      setTransport(null);
    }
  },
  { fingerprint: "morse.shutdown" },
);

/* ------------------------------------------------------------------------ */
/*  Test-only hooks (private)                                                */
/* ------------------------------------------------------------------------ */

/**
 * Reset the module-level singleton for tests. Customer code must NOT
 * call this — the singleton is meant to live for the process lifetime.
 *
 * @internal
 */
export function _resetForTesting(): void {
  if (singleton !== null) {
    void singleton.transport.shutdown();
    singleton = null;
    setTransport(null);
  }
  getOtelEngine().resetForTesting();
  noApiKeyWarningEmitted = false;
  lastLoggedEndpoint = null;
  _setSource(null);
  _resetTracingForTesting();
  _resetDiagnosticsForTesting();
  _resetAutoDetectForTesting();
  _resetQuotaStateForTesting();
  // Reset the transport factory back to the default.
  transportFactory = (opts) => new BatchTransport(opts);
}

/**
 * Inject an alternate transport factory for tests (e.g., a mock that
 * captures sent payloads instead of opening a fetch).
 *
 * @internal
 */
export function _setTransportFactoryForTesting(
  factory: (opts: {
    apiKey: string;
    endpoint: string;
    flushIntervalSeconds: number;
  }) => BatchTransport,
): void {
  transportFactory = factory;
}

/**
 * Read the most recently completed trace entry, for test assertions.
 *
 * @internal
 */
export function _getLastTraceForTesting(): { trace: unknown; spans: unknown[] } | null {
  return _getLastTrace();
}

/**
 * Read the active trace state, for test assertions.
 *
 * @internal
 */
export function _getActiveTraceStateForTesting(): unknown {
  return _getActiveTraceState();
}
