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

import { isLegacyTransport, isValidInternalSource } from "./env";
import { emitTraceEntry, isOtelAvailable, withOtelSpanContext } from "./otel-provider";
import { report, setRedactionConfig as setDiagnosticsRedactionConfig } from "./diagnostics";
import { buildRedactionConfig, type RedactionConfig, redactValue } from "./redaction";
import type { SpanData, SpanStatus, SpanType } from "./spans";
import { generateSpanId, generateTraceId, nowIso } from "./spans";

/* ------------------------------------------------------------------------ */
/*  Internal state                                                           */
/* ------------------------------------------------------------------------ */

export interface TraceState {
  traceId: string;
  agentName: string;
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
): void {
  span.ended_at = nowIso();
  span.duration_ms = elapsedMs(startMono);
  span.status = status;
  if (errorMessage !== undefined) {
    span.error_message = errorMessage;
  }
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
  // the root span as `av.source` / `av.framework`. Python has stamped the
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
    return withOtelSpanContext(traceId, spanIdHex.slice(0, 16), fn);
  } catch {
    return fn();
  }
}

/* ------------------------------------------------------------------------ */
/*  Public-ish run() and span() — wrapped at the module surface              */
/* ------------------------------------------------------------------------ */

export interface RunOptions {
  agentName: string;
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
    // Lazy import to avoid a cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractTraceparent } = require("../propagation") as typeof import("../propagation");
    const ctx = extractTraceparent(opts.incomingTraceparent);
    if (ctx) {
      traceId = ctx.traceId;
    }
  }
  if (!traceId) traceId = generateTraceId();

  const state: TraceState = {
    traceId,
    agentName: opts.agentName,
    spanStack: [],
    completedSpans: [],
  };
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
  const rootSpan: SpanData = {
    trace_id: traceId,
    span_id: generateSpanId(),
    type: "agent" as SpanType,
    name: opts.agentName,
    started_at: nowIso(),
    status: "completed",
  };
  state.spanStack.push(rootSpan);
  return { state, rootSpan, startMono: nowMonotonic() };
}

function endTrace(
  state: TraceState,
  rootSpan: SpanData,
  startMono: number,
  threwError: unknown,
): void {
  state.spanStack.pop();
  if (threwError !== undefined) {
    const msg = state.errorMessage ?? errToString(threwError);
    finalizeSpan(rootSpan, startMono, "failed", msg);
    if (state.success === undefined) state.success = false;
  } else if (state.errorMessage !== undefined) {
    finalizeSpan(rootSpan, startMono, "failed", state.errorMessage);
    // setError() already set state.success = false.
  } else {
    finalizeSpan(rootSpan, startMono);
    if (state.success === undefined) state.success = true;
  }
  const dict = buildTraceDict(state, rootSpan);
  sendTrace(dict);
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
  state.spanStack.push(span);
  return {
    span,
    end(error?: unknown): void {
      // Pop only if still on top — defensive against out-of-order ends.
      if (state.spanStack[state.spanStack.length - 1] === span) {
        state.spanStack.pop();
      }
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
  redactionConfig = buildRedactionConfig();
  // We do not reset `als` because re-loading it is expensive and the
  // store is process-scoped anyway.
}
