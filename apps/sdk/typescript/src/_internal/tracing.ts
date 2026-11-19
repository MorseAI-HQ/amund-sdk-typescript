/**
 * SDK V2 tracing core — TraceState, run(), span() context-manager-likes.
 *
 * Mirrors `apps/sdk/python/src/morse/tracing.py`. Key differences:
 *
 * - Python uses `contextvars.ContextVar` for async/coroutine isolation.
 *   In Node we use `node:async_hooks.AsyncLocalStorage` when available
 *   (server-side, including Next.js API routes). On the browser there
 *   is no equivalent; we fall back to a module-global slot. This is
 *   acceptable because in the browser there is exactly one event loop
 *   and one user — no parallel traces.
 *
 * - "Context manager" idioms in TS use callback-style: `run(name, fn)`
 *   and `span(name, type, fn)` accept a function and invoke it with
 *   the active state on the stack. We keep an explicit `start/end`
 *   pair on the public surface for callers who can't use callbacks
 *   (e.g., when the work spans an SSE stream).
 *
 * - MHQ-482: `run()`/`span()`/`runTraced()`'s emission path now goes
 *   through `./otel-provider` (real OTel spans over OTLP, Node-only —
 *   mirrors the Python SDK's MHQ-668 `otel_provider.py`). This is a
 *   deliberate Node-only deviation from this module's own browser
 *   fallback for `AsyncLocalStorage` above: `otel-provider.ts` statically
 *   imports `@opentelemetry/sdk-trace-node`, which pulls in Node built-ins
 *   (`node:crypto`, `node:http`/`https`) that don't exist in a browser
 *   bundle. A future browser-targeted build would need either a
 *   browser-flavored OTel exporter swapped in at this call site or to
 *   keep `MORSE_LEGACY_TRANSPORT=1`'s JSON path as the browser default —
 *   out of scope for this port (see the PR report's deviation notes).
 *
 * - MHQ-482 (db-capture follow-up): `runSync`/`runAsync`/`spanSync`/
 *   `spanAsync` now ALSO wrap `fn()` in a live OTel context via
 *   `otel-provider.ts::withOtelSpanContext` (Node only — a no-op
 *   passthrough everywhere else, including the browser fallback path,
 *   since that helper itself no-ops when the OTel engine isn't
 *   configured). This is what lets community DB-driver instrumentation
 *   (`./db-capture.ts`) — which reads OTel's *global*
 *   `context.active()`, not this module's `TraceState` — see the right
 *   trace id and nest under the right parent span id when a query runs
 *   inside an active `morse.span()`/`morse.run()` block. It's a
 *   deliberately separate mechanism from `emitTraceEntry`'s
 *   synthetic-parent trick: that one runs once at trace-close time over
 *   already-built `SpanData`; this one runs live, for spans this module
 *   never sees (they're built entirely inside the instrumentation
 *   package and exported directly to the same `NodeTracerProvider`).
 */

import {
  isFrameworkNodeName,
  isLegacyIdentity,
  resolveAgentIdentity,
  type IdentitySource,
} from "./agent-name";
import {
  addPromptRef,
  mergeRecordKeys,
  normalizeAgentVersion,
  normalizePromptRef,
  safeEntries,
  warnPromptRejected,
  type PromptRef,
} from "./attribution";
import { isLegacyTransport, isValidInternalSource } from "./env";
import { emitTraceEntry, isOtelAvailable, withOtelSpanContext } from "./otel-provider";
import { otelSpanIdFor } from "./span-ids";
import { report, setRedactionConfig as setDiagnosticsRedactionConfig } from "./diagnostics";
import { buildRedactionConfig, type RedactionConfig, redactValue } from "./redaction";
import { getGitRevision, getServiceVersion } from "./revision";
import type { SpanData, SpanStatus, SpanType } from "./spans";
import { generateSpanId, generateTraceId, nowIso } from "./spans";
import { extractTraceparent } from "../propagation";

/* ------------------------------------------------------------------------ */
/*  Internal state                                                           */
/* ------------------------------------------------------------------------ */

export interface TraceState {
  traceId: string;
  agentName: string;
  // AID-01: which ladder rung produced `agentName`. Absent under MORSE_AGENT_IDENTITY=legacy.
  identitySource?: IdentitySource;
  // AID-04: root agent an adapter discovered (graph / starting-agent name). First wins.
  frameworkRoot?: string;
  spanStack: SpanData[];
  completedSpans: SpanData[];
  // Mutable outcome fields — set by `run()` callers via the returned handle.
  success?: boolean;
  outcome?: string;
  errorMessage?: string;
  // Multi-turn attribution (MHQ-748). threadId groups traces in the same
  // conversation; userId is the app-layer end-user identifier. Both
  // optional — mirrors Python's `_TraceState.thread_id`/`user_id`.
  threadId?: string;
  userId?: string;
  // Cost-attribution dimensions — set via `run({ userMetadata })` at
  // trace-creation time, or mutated mid-trace via `setContext()` (MHQ-751).
  // Keys/values are always strings at the SDK boundary — mirrors Python's
  // `_TraceState.user_metadata`.
  userMetadata?: Record<string, string>;
  // Per-trace override of the resource-level `morse_ai.source` tag. Wins
  // over the process-level `_source` when set — mirrors Python's
  // `_TraceState.source_override`.
  sourceOverride?: string;
  // MHQ-859: framework recorded by whichever adapter fired first inside
  // this trace (`_internal/active-framework.ts`). Lifted onto the trace
  // resource as `morse_ai.framework` — mirrors Python's
  // `_TraceState.framework`. Absence is the signal; never defaulted.
  framework?: string;
  // INFRACAP-04: per-trace counters for default-on infra capture and the one
  // summary span per kind that absorbs calls past the cap. Owned by
  // `infra-shared.ts`; mirrors Python's `_TraceState.infra_counts/summaries`.
  infraCounts?: Record<string, number>;
  infraSummaries?: Record<string, SpanData>;
  // ATTR-01/04 (MHQ-1275): business-record keys, declared agent version and
  // prompt references. Already normalised (see `attribution.ts`) — buildTraceDict
  // and the OTLP mapper copy them out verbatim.
  recordKeys?: Record<string, string>;
  agentVersion?: string;
  prompts?: PromptRef[];
  // AID-04: the name passed to `run()` when it differs from the discovered root.
  appName?: string;
  // MHQ-1407: open holds on this trace (a streamed LLM response handed back to
  // the framework before it is read). The trace is finalised when the last
  // hold is released, not when the `run()` callback returns. See `holdTraceOpen`.
  openHolds?: number;
  // Set by `endTrace` while it waits for the holds; the last release calls it.
  onHoldsReleased?: () => void;
}

type AlsLike<T> = {
  getStore(): T | undefined;
  run<R>(value: T, fn: () => R): R;
};

let als: AlsLike<TraceState> | null = null;
let alsLoaded = false;
let browserState: TraceState | null = null;

function tryLoadAls(): AlsLike<TraceState> | null {
  if (alsLoaded) return als;
  alsLoaded = true;
  // Skip in the browser.
  if (typeof process === "undefined" || !process.versions?.node) {
    als = null;
    return als;
  }
  // MHQ-924: two resolution paths, tried in order. `require` alone is NOT
  // enough — it does not exist in ESM, so every `.mjs` / `"type": "module"`
  // consumer silently fell through to the browser fallback below. That
  // fallback is a module-global, which survives synchronous code but is lost
  // across the first `await`, so EVERY child span was dropped with "no active
  // trace" while the root span still persisted. Node consumers were never
  // getting AsyncLocalStorage at all.
  //
  // Order matters: getBuiltinModule first, because it is the only one of the
  // two that works in both module systems.
  //
  //   1. `process.getBuiltinModule` — Node 22.3+, synchronous, and identical
  //      in ESM and CJS. Not a bundler-visible specifier, so the browser
  //      build still cannot try to resolve `node:async_hooks`.
  //   2. runtime-eval'd `require` — CJS, and older Node versions.
  //
  // A dynamic `import()` is not an option: this function is synchronous and
  // is called on the hot path by getActiveTraceState().
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getBuiltin = (process as any)?.getBuiltinModule as ((m: string) => unknown) | undefined;
    if (typeof getBuiltin === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = getBuiltin("node:async_hooks") as any;
      if (mod?.AsyncLocalStorage) {
        als = new mod.AsyncLocalStorage() as AlsLike<TraceState>;
        return als;
      }
    }
  } catch {
    // Fall through to the require path.
  }
  try {
    // Use a runtime-eval'd require so the browser bundler doesn't try
    // to resolve `node:async_hooks`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dynamicRequire = Function("m", "return require(m)") as any as (m: string) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = dynamicRequire("node:async_hooks") as any;
    if (mod?.AsyncLocalStorage) {
      als = new mod.AsyncLocalStorage() as AlsLike<TraceState>;
      return als;
    }
  } catch {
    // Fall through to browser fallback.
  }
  // Genuinely no ALS: browser, or a Node old enough to have neither path.
  // The module-global fallback below is correct there — a browser has no
  // concurrent async contexts to confuse it.
  als = null;
  return als;
}

export function getActiveTraceState(): TraceState | null {
  const store = tryLoadAls();
  if (store) {
    return store.getStore() ?? null;
  }
  return browserState;
}

function setActiveTraceState(state: TraceState | null): () => void {
  // Returns a "reset" callback. Used only on the browser path. On Node,
  // `als.run()` handles the lifecycle.
  const previous = browserState;
  browserState = state;
  return () => {
    browserState = previous;
  };
}

/* ------------------------------------------------------------------------ */
/*  Transport injection                                                      */
/* ------------------------------------------------------------------------ */

export interface TransportLike {
  track(event: { traces: unknown[] } | Record<string, unknown>): boolean;
}

let transport: TransportLike | null = null;

export function setTransport(t: TransportLike | null): void {
  transport = t;
}

export function getTransport(): TransportLike | null {
  return transport;
}

/* ------------------------------------------------------------------------ */
/*  Redaction config — module-level, replaceable on init()                   */
/* ------------------------------------------------------------------------ */

// Default-on with the canonical catalogue. Replaced when `init()` runs
// with explicit redaction options. Customers calling SDK helpers before
// `init()` still get the default redaction floor.
let redactionConfig: RedactionConfig = buildRedactionConfig();

export function setRedactionConfig(config: RedactionConfig): void {
  redactionConfig = config;
  // Keep the diagnostics reporter's view in sync so an exception MESSAGE gets
  // the same redaction as span content (SDKDIAG-02). Pushed rather than pulled
  // to keep diagnostics free of a cycle back into tracing.
  setDiagnosticsRedactionConfig(config);
}

export function getRedactionConfig(): RedactionConfig {
  return redactionConfig;
}

/* ------------------------------------------------------------------------ */
/*  Resource-level "source" label (dogfood emitter discrimination)           */
/* ------------------------------------------------------------------------ */

// Process-level source tag. Lifted into each outgoing trace's `resource`
// dict so the backend can discriminate Morse's own dogfood emitters
// from customer traces. Mirrors the Python SDK's module-level `_source`.
let _source: string | null = null;

export function setSource(value: string | null | undefined): void {
  _source = value && value.length > 0 ? value : null;
}

export function getSource(): string | null {
  return _source;
}

// Process-level default `agent_version` from `init({ agentVersion })`; a per-run
// `RunOptions.agentVersion` overrides it. Normalised before storing.
let _agentVersionDefault: string | undefined;

export function setAgentVersionDefault(value: unknown): void {
  _agentVersionDefault = normalizeAgentVersion(value);
}

// SETUP-10: `init({ captureEndUser: true })` opt-in. Off by default: adapters
// never read the provider's `user` / `metadata.user_id` unless this is set.
let _captureEndUser = false;

export function setCaptureEndUser(value: unknown): void {
  _captureEndUser = value === true;
}

export function isCaptureEndUser(): boolean {
  return _captureEndUser;
}

let lastTrace: { trace: unknown; spans: unknown[] } | null = null;

export function getLastTrace(): { trace: unknown; spans: unknown[] } | null {
  return lastTrace;
}

/* ------------------------------------------------------------------------ */
/*  Trace lifecycle helpers                                                  */
/* ------------------------------------------------------------------------ */

function nowMonotonic(): number {
  // performance.now() is available in Node >= 16 globally and in all browsers.
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function elapsedMs(startMonotonic: number): number {
  return Math.max(0, Math.round(nowMonotonic() - startMonotonic));
}

function finalizeSpan(
  span: SpanData,
  startMono: number,
  status: SpanStatus = "completed",
  errorMessage?: string,
  thrown?: unknown,
): void {
  span.ended_at = nowIso();
  span.duration_ms = elapsedMs(startMono);
  span.status = status;
  if (errorMessage !== undefined) {
    span.error_message = errorMessage;
  }
  const exceptionType = errToTypeName(thrown);
  if (exceptionType !== undefined) {
    span.exception_type = exceptionType;
  }
}

/**
 * Class name of a thrown Error, preferring a custom subclass name over the
 * generic `Error` that `.name` reports for most subclasses. Non-Error throws
 * (strings, objects) have no type, so they group on message alone.
 */
export function errToTypeName(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const ctor = e.constructor?.name;
  if (e.name && e.name !== "Error") return e.name;
  return ctor && ctor !== "Object" ? ctor : "Error";
}

/**
 * Field allowlist for span-level redaction. Identifiers, timestamps,
 * counts, and types pass through untouched; user-supplied strings and
 * JSON blobs route through `redactValue`.
 */
const SPAN_REDACTABLE_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "input_data",
  "output_data",
  "error_message",
  "metadata",
]);

const TRACE_REDACTABLE_FIELDS: ReadonlySet<string> = new Set(["agent", "outcome", "error_message"]);

function redactSpanDict(
  raw: Record<string, unknown>,
  config: RedactionConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // MHQ-947: guarded PER FIELD. Span metadata is USER data, and reading or
  // redacting it runs arbitrary customer code — a getter, a `toString`. That
  // threw straight through `redactValue` -> `buildTraceDict` -> `endTrace` and
  // terminated the host process: instrumentation taking down the application
  // it observes, which is the one thing the non-invasive guarantee exists to
  // prevent. Confirmed reproducible on 0.5.0-rc.5.
  //
  // A bad field costs that field, not the trace. Losing one metadata key beats
  // losing the span, and losing the span beats crashing the customer.
  //
  // Note this no longer early-returns when redaction is disabled: the read
  // itself can throw, so the guard has to run either way.
  for (const k of Object.keys(raw)) {
    try {
      const v = raw[k];
      out[k] = config.enabled && SPAN_REDACTABLE_FIELDS.has(k) ? redactValue(v, config) : v;
    } catch (err) {
      report(err, { fingerprint: "morse.tracing.span_field_unreadable" });
      out[k] = "<unserializable>";
    }
  }
  return out;
}

function redactTraceDict(
  raw: Record<string, unknown>,
  config: RedactionConfig,
): Record<string, unknown> {
  if (!config.enabled) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (TRACE_REDACTABLE_FIELDS.has(k)) {
      out[k] = redactValue(v, config);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildTraceDict(
  state: TraceState,
  rootSpan: SpanData,
): {
  trace: Record<string, unknown>;
  spans: Record<string, unknown>[];
} {
  const trace: Record<string, unknown> = {
    trace_id: state.traceId,
    // Wire-format field is `agent` (matches backend TracePayloadIn schema +
    // sibling Python SDK). Was `agent_name` historically — the mismatch
    // caused dev ingest to reject every TS-emitted trace with a 422
    // until Phase 13 Option A dogfood surfaced it.
    agent: state.agentName,
    status: rootSpan.status,
    started_at: rootSpan.started_at,
  };
  if (rootSpan.ended_at) trace.ended_at = rootSpan.ended_at;
  if (rootSpan.duration_ms !== undefined) trace.duration_ms = rootSpan.duration_ms;
  if (rootSpan.error_message) trace.error_message = rootSpan.error_message;
  if (state.success !== undefined) trace.success = state.success;
  if (state.outcome !== undefined) trace.outcome = state.outcome;
  // MHQ-748/MHQ-751: multi-turn + cost-attribution dimensions. Field names
  // (`thread_id`/`user_id`/`user_metadata`) match the backend's
  // `TracePayloadIn` schema exactly (apps/api/apps/traces/schemas.py) and
  // the sibling Python SDK's `_build_trace_dict` — do not camelCase these.
  if (state.threadId !== undefined) trace.thread_id = state.threadId;
  if (state.userId !== undefined) trace.user_id = state.userId;
  if (state.userMetadata && Object.keys(state.userMetadata).length > 0) {
    trace.user_metadata = state.userMetadata;
  }
  // ATTR-01/04: omitted entirely when empty, so an old server and a trace that
  // declared nothing see the exact payload they always did.
  if (state.recordKeys && Object.keys(state.recordKeys).length > 0) {
    trace.record_keys = { ...state.recordKeys };
  }
  if (state.agentVersion) trace.agent_version = state.agentVersion;
  if (state.prompts && state.prompts.length > 0) {
    trace.prompts = state.prompts.map((p) => ({ ...p }));
  }
  // AID-01/AID-04: trace metadata keys `identity_source` and `morse_app` (Wave 1 contract).
  if (state.identitySource !== undefined || state.appName !== undefined) {
    trace.metadata = {
      ...(state.identitySource !== undefined ? { identity_source: state.identitySource } : {}),
      ...(state.appName !== undefined ? { morse_app: state.appName } : {}),
    };
  }

  const allSpans = [rootSpan, ...state.completedSpans];
  const spans = allSpans.map((s) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) {
      if (v !== undefined && v !== null) {
        out[k] = v;
      }
    }
    return out;
  });

  const config = redactionConfig;
  const out = {
    trace: redactTraceDict(trace, config),
    spans: spans.map((s) => redactSpanDict(s, config)),
  };
  // Per-trace `sourceOverride` wins over the process-level `_source` —
  // mirrors Python's `_build_trace_dict`'s `effective_source = state.source_override or _source`.
  const effectiveSource = state.sourceOverride || _source;
  // MHQ-859: `morse_ai.framework` rides the same resource envelope as
  // `morse_ai.source` — both are per-trace values a process-wide OTel
  // Resource cannot express, and `otel-provider.ts` already lifts both onto
  // the root span as `morse.source` / `morse.framework`. Python has stamped the
  // framework since AGE-240; TS never did, so every TS trace landed with
  // `framework` NULL.
  const resource: Record<string, unknown> = {};
  if (effectiveSource) {
    // Lift the source label onto the trace envelope so the backend can
    // route dogfood-emitter traces to the internal dashboards. Mirrors
    // Python's `resource["morse_ai.source"]`.
    resource["morse_ai.source"] = effectiveSource;
  }
  if (state.framework) {
    resource["morse_ai.framework"] = state.framework;
  }
  // ATTR-06: process-level deployment identity, detected once at init().
  const gitRevision = getGitRevision();
  if (gitRevision) resource["git.revision"] = gitRevision;
  const serviceVersion = getServiceVersion();
  if (serviceVersion) resource["service.version"] = serviceVersion;
  if (Object.keys(resource).length > 0) {
    (out as Record<string, unknown>).resource = resource;
  }
  return out;
}

/**
 * `run()` / `span()` / `runTraced()`'s emission path: real OTel spans over
 * OTLP (MHQ-482, mirrors Python's `tracing.py::_finish_trace`, MHQ-668).
 * Always updates `lastTrace` (test/debug introspection — same bookkeeping
 * regardless of which pipeline actually ships the trace), then hands the
 * dict to `otel-provider.ts::emitTraceEntry()` — unless
 * `MORSE_LEGACY_TRANSPORT=1`, in which case it falls back to the old JSON
 * queue path instead (rollback escape hatch; never both, to avoid
 * double-ingesting the same trace).
 *
 * Exported (MHQ-746) so `index.ts::record()` can submit a synthetic
 * single-span trace through this same pipeline instead of the defunct
 * `runs`-shaped `state.transport.track()` path — mirrors the Python SDK's
 * `client.py::record()`, which builds a trace + span dict and calls this
 * module's `_send_trace()` directly rather than going through `track()`.
 */
export function sendTrace(entry: {
  trace: Record<string, unknown>;
  spans: Record<string, unknown>[];
}): void {
  lastTrace = entry;

  // `!isOtelAvailable()` is the browser build (see `otel-provider.browser.ts`):
  // the OTLP pipeline is Node-only, so browser traces take the same JSON path
  // the legacy escape hatch uses rather than being dropped. Still never both.
  if (isLegacyTransport() || !isOtelAvailable()) {
    if (transport !== null) {
      try {
        transport.track({ traces: [entry] });
      } catch {
        // never propagate
      }
    }
    return;
  }

  try {
    emitTraceEntry(entry);
  } catch {
    // never propagate — mirrors the rest of the SDK's non-invasive guarantee
  }
}

/**
 * Run `fn` with the OTel-global active context set to a synthetic
 * `SpanContext` for `spanIdHex` under `traceId` (MHQ-482 db-capture
 * correlation — see the module docstring). No-op passthrough if the OTel
 * engine isn't configured (browser, uninitialized SDK, or
 * `otel-provider.ts` import failure) — never throws, mirrors the rest of
 * this module's non-invasive guarantee.
 */
function withDbCaptureContext<T>(traceId: string, spanIdHex: string, fn: () => T): T {
  try {
    // OTel SpanId is 64-bit (16 hex chars); Morse's span_id is 128-bit
    // (32 hex chars) — same truncation convention `spans.ts::generateSpanId`
    // documents for W3C traceparent interop.
    return withOtelSpanContext(traceId, otelSpanIdFor(spanIdHex), fn);
  } catch {
    return fn();
  }
}

/* ------------------------------------------------------------------------ */
/*  Public-ish run() and span() — wrapped at the module surface              */
/* ------------------------------------------------------------------------ */

export interface RunOptions {
  /**
   * Explicit agent name from customer code. Optional (MHQ-1100): when
   * omitted, the name resolves from the framework-native name, the env
   * service name, the entry script, then `"default-agent"` — see
   * `_internal/agent-name.ts`.
   */
  agentName?: string;
  /**
   * Alias of `agentName` (MHQ-1415): `run({ name })` is what the runbooks and the
   * Python-style call shape suggest, and it used to be silently ignored.
   */
  name?: string;
  /** Framework-native name an integration knows (graph/agent name). Ranks below `agentName`. */
  frameworkAgentName?: string;
  /** W3C traceparent value to continue an upstream trace, when available. */
  incomingTraceparent?: string | null;
  /**
   * Application-layer conversation/thread identifier (MHQ-748). Groups all
   * traces from the same multi-turn session so the dashboard can show the
   * full conversation history for a thread. Mirrors Python's
   * `run(thread_id=...)`.
   */
  threadId?: string;
  /**
   * Application-layer end-user identifier (e.g. a user primary key or
   * email) (MHQ-748). Enables per-user filtering in the dashboard. Mirrors
   * Python's `run(user_id=...)`.
   */
  userId?: string;
  /**
   * Cost-attribution dimensions attached to this trace at creation time
   * (e.g. `customer_id`, `feature`, `env`, `team`) (MHQ-748). Values are
   * coerced to strings. Can also be set/merged mid-trace via
   * `setContext()` (MHQ-751). Mirrors Python's `run(user_metadata=...)`.
   */
  userMetadata?: Record<string, unknown>;
  /**
   * INTERNAL USE ONLY — per-trace override for the resource-level
   * `morse_ai.source` tag. Wins over the process-level source set at
   * `init({ source })`. Accepted values: `"copilot" | "investigator" |
   * "refagent" | "ui-bot"`; anything else is silently ignored and the
   * process-level source is used. Customer code should leave this unset.
   * Mirrors Python's `run(source=...)`.
   */
  source?: string;
  /**
   * Business-record keys to link this trace to, e.g. `{ zendesk_ticket: "4812" }`
   * (ATTR-01). Key types are lower-cased and must match
   * `^[a-z0-9][a-z0-9_.-]{0,63}$`; values are strings or numbers of 1-256
   * characters. Invalid pairs are dropped, never thrown; at most 20 per trace.
   * Use opaque ids, not personal data. More can be added mid-trace with
   * `linkRecord()`. Mirrors Python's `run(record_keys=...)`.
   */
  recordKeys?: Record<string, string | number>;
  /**
   * Version of the agent this run belongs to (ATTR-04), e.g. a release tag.
   * Overrides the `init({ agentVersion })` default for this run. Truncated to
   * 128 characters. Mirrors Python's `run(agent_version=...)`.
   */
  agentVersion?: string;
}

export interface RunHandle {
  setOutcome(success: boolean, outcome?: string): void;
  setError(message: string): void;
  /** Internal — set by `runSync`/`runAsync`. */
  _state: TraceState;
}

function buildRunHandle(state: TraceState): RunHandle {
  return {
    setOutcome(success, outcome) {
      state.success = success;
      if (outcome !== undefined) state.outcome = outcome;
    },
    setError(message) {
      state.errorMessage = message;
      state.success = false;
    },
    _state: state,
  };
}

function startTrace(opts: RunOptions): {
  state: TraceState;
  rootSpan: SpanData;
  startMono: number;
} {
  let traceId: string | undefined;
  if (opts.incomingTraceparent) {
    // Static import (was a lazy `require()`, which does not exist in the ESM
    // build, so `run({ incomingTraceparent })` threw there). The import cycle
    // with propagation.ts is harmless: both sides only call each other at run
    // time, never while the modules are evaluating.
    const ctx = extractTraceparent(opts.incomingTraceparent);
    if (ctx) {
      traceId = ctx.traceId;
    }
  }
  if (!traceId) traceId = generateTraceId();

  const identity = resolveAgentIdentity({
    explicit: opts.agentName ?? opts.name,
    framework: opts.frameworkAgentName,
  });
  const agentName = identity.name;
  const state: TraceState = {
    traceId,
    agentName,
    spanStack: [],
    completedSpans: [],
  };
  if (!isLegacyIdentity()) state.identitySource = identity.source;
  if (opts.threadId !== undefined) state.threadId = opts.threadId;
  if (opts.userId !== undefined) state.userId = opts.userId;
  if (opts.userMetadata) {
    state.userMetadata = coerceDims(opts.userMetadata, "morse.tracing.run.user_metadata");
  }
  // Validate against the same whitelist as `init({ source })` — an invalid
  // value falls through to whatever the process has set (never throws).
  if (isValidInternalSource(opts.source)) {
    state.sourceOverride = opts.source;
  }
  // ATTR-01/04. Both are normalised without ever throwing, so a bad value costs
  // that value, not the callback the trace wraps.
  try {
    if (opts.recordKeys !== undefined) {
      const keys: Record<string, string> = {};
      mergeRecordKeys(keys, safeEntries(opts.recordKeys));
      if (Object.keys(keys).length > 0) state.recordKeys = keys;
    }
    const agentVersion = normalizeAgentVersion(opts.agentVersion) ?? _agentVersionDefault;
    if (agentVersion !== undefined) state.agentVersion = agentVersion;
  } catch (err) {
    report(err, { fingerprint: "morse.tracing.run.attribution" });
  }
  const rootSpan: SpanData = {
    trace_id: traceId,
    span_id: generateSpanId(),
    type: "agent" as SpanType,
    name: agentName,
    started_at: nowIso(),
    status: "completed",
  };
  state.spanStack.push(rootSpan);
  return { state, rootSpan, startMono: nowMonotonic() };
}

/**
 * Longest a trace is held open by `holdTraceOpen` after its `run()` callback
 * returned. A stream nobody reads never ends; past this the trace is sent with
 * what it has.
 */
export const TRACE_HOLD_MAX_MS = 10 * 60 * 1000;

/**
 * MHQ-1407: keep the active trace open until the returned release is called.
 *
 * A streamed route returns the response before the stream is read, so
 * `run(() => { const r = streamText(...); return r.toUIMessageStreamResponse(); })`
 * used to close the trace in milliseconds and drop the llm span, its usage and
 * every span the stream's tools made. Adapters take a hold when a stream starts
 * and release it when the stream ends; `run()` still returns as soon as its
 * callback does, and only the trace's finalisation waits (bounded by
 * `TRACE_HOLD_MAX_MS`). Releasing is synchronous, so a stream fully read inside
 * the callback ends the trace exactly as before. Returns null when no trace is
 * active. The release is idempotent and never throws.
 */
export function holdTraceOpen(): (() => void) | null {
  try {
    const state = getActiveTraceState();
    if (state === null) return null;
    state.openHolds = (state.openHolds ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        state.openHolds = Math.max(0, (state.openHolds ?? 1) - 1);
        if (state.openHolds === 0 && state.onHoldsReleased) {
          const resume = state.onHoldsReleased;
          state.onHoldsReleased = undefined;
          resume();
        }
      } catch (err) {
        report(err, { fingerprint: "morse.tracing.release_hold" });
      }
    };
  } catch {
    return null;
  }
}

function endTrace(
  state: TraceState,
  rootSpan: SpanData,
  startMono: number,
  threwError: unknown,
): void {
  if (!state.openHolds) {
    endTraceNow(state, rootSpan, startMono, threwError);
    return;
  }
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    state.onHoldsReleased = undefined;
    try {
      endTraceNow(state, rootSpan, startMono, threwError);
    } catch (err) {
      report(err, { fingerprint: "morse.tracing.end_trace_deferred" });
    }
  };
  const timer = setTimeout(finish, TRACE_HOLD_MAX_MS);
  (timer as { unref?: () => void }).unref?.();
  state.onHoldsReleased = finish;
}

function endTraceNow(
  state: TraceState,
  rootSpan: SpanData,
  startMono: number,
  threwError: unknown,
): void {
  // Remove the root itself, not whatever is on top: a span that is still open
  // (a stream nobody finished reading) must not leave the root on the stack.
  const rootIdx = state.spanStack.lastIndexOf(rootSpan);
  if (rootIdx >= 0) state.spanStack.splice(rootIdx, 1);
  else state.spanStack.pop();
  if (threwError !== undefined) {
    const msg = state.errorMessage ?? errToString(threwError);
    finalizeSpan(rootSpan, startMono, "failed", msg, threwError);
    // A crash is a fact, not a guess — failure metrics filter on success=false.
    if (state.success === undefined) state.success = false;
  } else if (state.errorMessage !== undefined) {
    finalizeSpan(rootSpan, startMono, "failed", state.errorMessage);
    // setError() already set state.success = false.
  } else {
    finalizeSpan(rootSpan, startMono);
  }
  applyFrameworkRoot(state, rootSpan);
  // MHQ-1157: a clean exit is not proof of success, so it sends no `success`
  // (the server would store it as provenance 'developer').
  const dict = buildTraceDict(state, rootSpan);
  sendTrace(dict);
}

/**
 * AID-01/AID-04: fold the root an adapter discovered into the trace identity.
 *
 * A framework-native root outranks the service name and the entry script, so it
 * replaces them. `run("name")` outranks it as a label only: the name moves to
 * `appName` (`morse.app`) and the discovered root stays the agent, so the topology
 * keeps one root instead of forking a second agent above it. No-op in legacy mode.
 */
function applyFrameworkRoot(state: TraceState, rootSpan: SpanData): void {
  const root = state.frameworkRoot;
  if (!root || state.identitySource === undefined || root === state.agentName) return;
  if (state.identitySource === "run") state.appName = state.agentName;
  state.agentName = root;
  state.identitySource = "framework";
  rootSpan.name = root;
}

/**
 * Record the root agent a framework adapter found (graph name, starting agent) on the
 * active trace. First call wins; framework plumbing names (`LangGraph`, `chain`) never
 * count. Never throws.
 */
export function adoptFrameworkRoot(name: unknown): void {
  const state = getActiveTraceState();
  if (state === null || state.frameworkRoot !== undefined) return;
  if (typeof name !== "string" || name.trim() === "" || isFrameworkNodeName(name)) return;
  state.frameworkRoot = name.trim();
}

/** The root an adapter adopted on the active trace, if any. */
export function getFrameworkRoot(): string | undefined {
  return getActiveTraceState()?.frameworkRoot;
}

let pendingParentSpanId: string | undefined;

/**
 * AID-05: run `fn` with `startSpan` parenting its span to `parentSpanId` instead of the
 * top of the span stack. Callback frameworks (LangGraph, LangChain) run branches
 * concurrently, so "top of stack" is whichever sibling started last. A span parented
 * this way is not pushed on the stack either, so siblings cannot adopt it.
 * Synchronous only: the override is consumed by the first span `fn` starts.
 */
export function withParentSpan<T>(parentSpanId: string | undefined, fn: () => T): T {
  if (parentSpanId === undefined) return fn();
  pendingParentSpanId = parentSpanId;
  try {
    return fn();
  } finally {
    pendingParentSpanId = undefined;
  }
}

function errToString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/* ------------------------------------------------------------------------ */
/*  Sync + async run() wrappers                                              */
/* ------------------------------------------------------------------------ */

/** True for anything await-able, without assuming a real Promise. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export function runSync<T>(opts: RunOptions, fn: (handle: RunHandle) => T): T | undefined {
  const { state, rootSpan, startMono } = startTrace(opts);
  const handle = buildRunHandle(state);
  const store = tryLoadAls();

  const runFn = (): T => withDbCaptureContext(state.traceId, rootSpan.span_id, () => fn(handle));

  // MHQ-924 (defect B): if `fn` is async, closing the trace here would send it
  // before the body has run, so `state.completedSpans` is still empty and
  // EVERY child span is lost. The root span still lands, so the trace looks
  // healthy — it is just silently truncated. `run()` accepts an async callback
  // (its signature cannot refuse one), so "use runTraced() instead" was a
  // documented footgun rather than a safeguard: three adapters and the pino
  // integration each landed exactly one span in live testing because of it.
  //
  // Settling first keeps the sync path byte-identical — a non-thenable result
  // still ends the trace inline — while making the async path correct.
  const settle = (result: T, onDone: () => void): T => {
    if (!isThenable(result)) {
      endTrace(state, rootSpan, startMono, undefined);
      onDone();
      return result;
    }
    return (result as PromiseLike<unknown>).then(
      (value) => {
        endTrace(state, rootSpan, startMono, undefined);
        onDone();
        return value;
      },
      (err) => {
        endTrace(state, rootSpan, startMono, err);
        onDone();
        throw err;
      },
    ) as unknown as T;
  };

  if (store) {
    try {
      return settle(store.run(state, runFn), () => {});
    } catch (err) {
      endTrace(state, rootSpan, startMono, err);
      throw err;
    }
  } else {
    // Browser fallback: the reset must not fire until an async body has
    // settled, or the module-global is cleared out from under it.
    const reset = setActiveTraceState(state);
    try {
      return settle(runFn(), reset);
    } catch (err) {
      endTrace(state, rootSpan, startMono, err);
      reset();
      throw err;
    }
  }
}

export async function runAsync<T>(
  opts: RunOptions,
  fn: (handle: RunHandle) => Promise<T>,
): Promise<T | undefined> {
  const { state, rootSpan, startMono } = startTrace(opts);
  const handle = buildRunHandle(state);
  const store = tryLoadAls();

  const runFn = (): Promise<T> =>
    withDbCaptureContext(state.traceId, rootSpan.span_id, () => fn(handle));

  if (store) {
    try {
      const result = await store.run(state, runFn);
      endTrace(state, rootSpan, startMono, undefined);
      return result;
    } catch (err) {
      endTrace(state, rootSpan, startMono, err);
      throw err;
    }
  } else {
    const reset = setActiveTraceState(state);
    try {
      const result = await runFn();
      endTrace(state, rootSpan, startMono, undefined);
      return result;
    } catch (err) {
      endTrace(state, rootSpan, startMono, err);
      throw err;
    } finally {
      reset();
    }
  }
}

/**
 * Attach cost-attribution dimensions to the active trace (MHQ-751).
 *
 * Call once per request (e.g. in Express/Next.js middleware) to propagate
 * `customer_id`, `feature`, `env`, `team`, etc. to all child spans
 * automatically. Mirrors Python's `morse_ai.set_context(**dims)`.
 *
 *     morse.setContext({ customerId: request.customerId, feature: "doc-qa" });
 *
 * Values are coerced to strings via `String(v)` — mirrors Python's `str()`
 * coercion. Merges into any dimensions already set (e.g. via
 * `run({ userMetadata })`) rather than replacing them. No-op outside an
 * active trace — never throws.
 */
export function setContext(dims: Record<string, unknown>): void {
  const state = getActiveTraceState();
  if (state === null) return;
  if (state.userMetadata === undefined) state.userMetadata = {};
  Object.assign(state.userMetadata, coerceDims(dims, "morse.tracing.set_context"));
}

/**
 * Declare the outcome of the active trace. Same effect as
 * `handle.setOutcome()`, without needing the handle. No-op outside a trace.
 */
export function setOutcome(success: boolean, outcome?: string): void {
  const state = getActiveTraceState();
  if (state === null) return;
  state.success = success;
  if (outcome !== undefined) state.outcome = outcome;
}

/**
 * Link the active trace to a business record (ATTR-01): a ticket, order, PR,
 * anything an outcome can later be reported against by id.
 *
 *     morse.linkRecord("zendesk_ticket", ticket.id);
 *
 * `keyType` is lower-cased and must match `^[a-z0-9][a-z0-9_.-]{0,63}$`;
 * `keyValue` is a string or number of 1-256 characters after trimming. Calls
 * accumulate (the same type again replaces its value); a trace keeps at most 20.
 * Invalid input is dropped with a one-time warning, never thrown. Use opaque
 * ids, not personal data such as an email address. No-op outside a trace.
 */
export function linkRecord(keyType: string, keyValue: string | number): void {
  try {
    const state = getActiveTraceState();
    if (state === null) return;
    if (state.recordKeys === undefined) state.recordKeys = {};
    mergeRecordKeys(state.recordKeys, [[keyType, keyValue]]);
  } catch (err) {
    report(err, { fingerprint: "morse.tracing.link_record" });
  }
}

/**
 * Declare that the active trace used a prompt (ATTR-04). Inside a
 * `morse.span()` block the reference is pinned to that span; at the top level of
 * a run it belongs to the trace. `version` is optional — teams that keep prompts
 * in code can omit it and rely on `agentVersion` or the git revision. Anything
 * that is not an integer ≥1 is dropped and the name kept. A trace keeps at most
 * 20 references. Never throws; no-op outside a trace.
 *
 * Over OTLP a span carries one reference, so when several are set on the same
 * span the last is exported (the legacy JSON path keeps all).
 */
export function setPrompt(name: string, version?: number | string): void {
  try {
    const state = getActiveTraceState();
    if (state === null) return;
    const top = state.spanStack[state.spanStack.length - 1];
    // spanStack[0] is the root span: a call made directly in run() is trace-level.
    const spanId = state.spanStack.length > 1 ? top?.span_id : undefined;
    const ref = normalizePromptRef(name, version, spanId);
    if (ref === null) {
      warnPromptRejected();
      return;
    }
    if (state.prompts === undefined) state.prompts = [];
    addPromptRef(state.prompts, ref);
  } catch (err) {
    report(err, { fingerprint: "morse.tracing.set_prompt" });
  }
}

/**
 * UP-09: link the run that is active NOW to a prompt `getPrompt()` just resolved.
 * Same path as `setPrompt` (span-pinned inside `span()`, trace-level otherwise) but the
 * ref is tagged `link_source: "fetch"`. Returns true when a run was active and the
 * reference was recorded (or upgraded from a `setPrompt` ref). Never throws.
 *
 * @internal
 */
export function linkFetchedPrompt(name: string, version: number): boolean {
  try {
    const state = getActiveTraceState();
    if (state === null) return false;
    const top = state.spanStack[state.spanStack.length - 1];
    const spanId = state.spanStack.length > 1 ? top?.span_id : undefined;
    const ref = normalizePromptRef(name, version, spanId);
    if (ref === null) return false;
    ref.link_source = "fetch";
    if (state.prompts === undefined) state.prompts = [];
    addPromptRef(state.prompts, ref);
    return true;
  } catch (err) {
    report(err, { fingerprint: "morse.tracing.link_fetched_prompt" });
    return false;
  }
}

/**
 * Set `threadId` on the active trace when nothing has claimed it yet.
 *
 * MHQ-1029 (the TypeScript half of MHQ-1022): no adapter populated `threadId`,
 * so every auto-opened trace landed with `thread_id: null` and a five-turn
 * conversation showed up as five unrelated traces. Each framework keeps
 * conversation identity somewhere different — an openai-agents `session` /
 * run context, a LangGraph `configurable.thread_id`, the Agent SDK's session id
 * — so extraction stays per-adapter and this is the one place that writes it,
 * which is where precedence gets decided once.
 *
 * An explicit `run({ threadId })` from app code always wins; adapters only fill
 * the gap. Never throws: `String()` runs customer `toString`/`valueOf` code.
 */
export function adoptThreadId(value: unknown): void {
  const state = getActiveTraceState();
  if (state === null || state.threadId !== undefined || value === null || value === undefined) {
    return;
  }
  try {
    const s = String(value);
    if (s !== "") state.threadId = s;
  } catch (err) {
    report(err, { fingerprint: "morse.tracing.adopt_thread_id" });
  }
}

/**
 * `String()` every value, dropping any that throws. Never throws. (MHQ-947)
 *
 * Cost-attribution dimensions are USER values, and the SDK is the one choosing
 * to stringify them — so a bare `String(v)` runs arbitrary customer code
 * (`toString`, `valueOf`) on the telemetry path. An exception there propagated
 * into the caller: `setContext()` threw into host code, and
 * `run({ userMetadata })` threw at trace START, taking the whole callback with
 * it. Both confirmed reproducible on 0.5.0-rc.5.
 *
 * The trigger is not exotic — an ORM object whose `toString` lazily hits a
 * dead connection is a realistic, non-malicious source.
 *
 * Guarded PER KEY rather than per call: wrapping the entry point would discard
 * every dimension because one was bad, and losing a customer's `customerId`
 * because their `feature` object misbehaved is the worse answer. Mirrors the
 * Python SDK's `coerce_dims`.
 */
export function coerceDims(
  dims: Record<string, unknown>,
  fingerprint: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(dims)) {
    try {
      out[k] = String(dims[k]);
    } catch (err) {
      report(err, { fingerprint });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/*  span() child-span helpers                                                */
/* ------------------------------------------------------------------------ */

export interface SpanOptions {
  name: string;
  type?: SpanType;
  metadata?: Record<string, unknown>;
}

export interface SpanHandle {
  /** Mutate the underlying span data (e.g., set tokens / cost). */
  span: SpanData;
  end(error?: unknown): void;
}

// MHQ-806. Latches the "no active trace" warning to once per process — see
// startSpan for why it warns at all, and why not on every call.
let spanOutsideTraceWarningEmitted = false;

/** Test hook — clears the once-per-process latch. */
export function _resetSpanOutsideTraceWarning(): void {
  spanOutsideTraceWarningEmitted = false;
}

/** Start a child span under the active trace, returning a handle to close it. */
export function startSpan(opts: SpanOptions): SpanHandle | null {
  const state = getActiveTraceState();
  if (state === null) {
    // No active trace — returns null rather than throwing, because library
    // code may be instrumented but reached from an untraced path.
    //
    // The null is visible in the type here, unlike Python's context-manager
    // form, but callers routinely ignore it (`span({...}, () => { ... })`
    // never touches the handle), so the outcome is the same: no error, no
    // spans, nothing distinguishing it from working instrumentation.
    //
    // Warned once per process, matching the existing not-initialized warning
    // in index.ts — this sits inside request and agent loops, so per-call
    // logging would bury the signal. This is the single choke point for
    // startSpan / spanSync / spanAsync.
    if (!spanOutsideTraceWarningEmitted) {
      spanOutsideTraceWarningEmitted = true;
      console.warn(
        `morse: span(${JSON.stringify(opts.name)}) was called with no active trace, so nothing ` +
          `was recorded. Wrap the work in morse.run('<agent-name>', () => { ... }) — run() opens ` +
          `the trace that span() attaches to. This warning prints once per process.`,
      );
    }
    return null;
  }
  const explicitParent = pendingParentSpanId;
  pendingParentSpanId = undefined;
  const parent = state.spanStack[state.spanStack.length - 1];
  const span: SpanData = {
    trace_id: state.traceId,
    span_id: generateSpanId(),
    type: opts.type ?? "custom",
    name: opts.name,
    parent_span_id: explicitParent ?? parent?.span_id,
    started_at: nowIso(),
    status: "completed",
    metadata: opts.metadata,
  };
  const startMono = nowMonotonic();
  if (explicitParent === undefined) state.spanStack.push(span);
  return {
    span,
    end(error?: unknown): void {
      // Pop only if still on top — defensive against out-of-order ends.
      if (state.spanStack[state.spanStack.length - 1] === span) {
        state.spanStack.pop();
      }
      if (error !== undefined) {
        finalizeSpan(span, startMono, "failed", errToString(error), error);
      } else {
        finalizeSpan(span, startMono);
      }
      state.completedSpans.push(span);
    },
  };
}

export interface DetachedSpan {
  span: SpanData;
  /** Close the span and record it on its trace. Safe to call from any async context. */
  end(error?: unknown): void;
}

/**
 * Start a span under the active trace WITHOUT putting it on the span stack
 * (INFRACAP). Infra captures (an HTTP request, a queue publish) start in one
 * callback and finish in another, often after the caller has moved on; a
 * stacked span would adopt unrelated siblings as children and, if `end` never
 * ran, corrupt parentage for the rest of the trace. A detached span cannot do
 * either: its parent is whatever was on top when it started, and an `end` that
 * never comes simply means the span is never recorded.
 *
 * Returns null when no trace is active.
 */
export function startDetachedSpan(opts: SpanOptions): DetachedSpan | null {
  const state = getActiveTraceState();
  if (state === null) return null;
  const parent = state.spanStack[state.spanStack.length - 1];
  const span: SpanData = {
    trace_id: state.traceId,
    span_id: generateSpanId(),
    type: opts.type ?? "custom",
    name: opts.name,
    parent_span_id: parent?.span_id,
    started_at: nowIso(),
    status: "completed",
    metadata: opts.metadata,
  };
  const startMono = nowMonotonic();
  let ended = false;
  return {
    span,
    end(error?: unknown): void {
      if (ended) return;
      ended = true;
      if (error !== undefined) {
        finalizeSpan(span, startMono, "failed", errToString(error));
      } else {
        finalizeSpan(span, startMono);
      }
      state.completedSpans.push(span);
    },
  };
}

/** Sync callback wrapper for `startSpan` / `end`. No-op if no active trace. */
export function spanSync<T>(opts: SpanOptions, fn: (handle: SpanHandle | null) => T): T {
  const handle = startSpan(opts);
  try {
    const result = handle
      ? withDbCaptureContext(handle.span.trace_id, handle.span.span_id, () => fn(handle))
      : fn(handle);
    handle?.end();
    return result;
  } catch (err) {
    handle?.end(err);
    throw err;
  }
}

/** Async callback wrapper for `startSpan` / `end`. No-op if no active trace. */
export async function spanAsync<T>(
  opts: SpanOptions,
  fn: (handle: SpanHandle | null) => Promise<T>,
): Promise<T> {
  const handle = startSpan(opts);
  try {
    const result = handle
      ? await withDbCaptureContext(handle.span.trace_id, handle.span.span_id, () => fn(handle))
      : await fn(handle);
    handle?.end();
    return result;
  } catch (err) {
    handle?.end(err);
    throw err;
  }
}

/* ------------------------------------------------------------------------ */
/*  Test helpers                                                             */
/* ------------------------------------------------------------------------ */

export function _resetForTesting(): void {
  browserState = null;
  lastTrace = null;
  _agentVersionDefault = undefined;
  _captureEndUser = false;
  redactionConfig = buildRedactionConfig();
  // We do not reset `als` because re-loading it is expensive and the
  // store is process-scoped anyway.
}
