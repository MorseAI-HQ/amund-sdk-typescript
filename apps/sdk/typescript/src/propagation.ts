/**
 * W3C Trace Context propagation — inject and extract `traceparent` headers.
 *
 * W3C traceparent format: `{version}-{trace_id}-{span_id}-{flags}`
 *   - version  : "00" (fixed)
 *   - trace_id : 32 lowercase hex chars (128-bit)
 *   - span_id  : 16 lowercase hex chars (64-bit)
 *   - flags    : "01" sampled / "00" not sampled, from the SDK's real head-sampling
 *                decision for the trace (`MORSE_SAMPLE_RATE`)
 *
 * Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 *
 * References:
 *   https://www.w3.org/TR/trace-context/
 */

import { getEngine as getOtelEngine } from "./_internal/otel-provider";
import { otelSpanIdFor } from "./_internal/span-ids";
import { getActiveTraceState } from "./_internal/tracing";

export const W3C_TRACEPARENT_HEADER = "traceparent";
export const W3C_VERSION = "00";
export const W3C_FLAGS_SAMPLED = "01";
export const W3C_FLAGS_NOT_SAMPLED = "00";

const TRACE_ID_LEN = 32;
const SPAN_ID_LEN = 16;

/**
 * Build a W3C traceparent value from explicit IDs.
 *
 * Useful when you have a trace_id / span_id from somewhere other than
 * the active context (e.g., re-emitting an upstream trace's IDs).
 */
export function formatTraceparent(
  traceId: string,
  spanId: string,
  flags: string = W3C_FLAGS_SAMPLED,
): string {
  // We trust the caller; the "build then validate" assumption is documented.
  const tid = traceId.slice(0, TRACE_ID_LEN).padStart(TRACE_ID_LEN, "0").toLowerCase();
  const sid = spanId.slice(0, SPAN_ID_LEN).padStart(SPAN_ID_LEN, "0").toLowerCase();
  return `${W3C_VERSION}-${tid}-${sid}-${flags}`;
}

/**
 * Inject the W3C `traceparent` header derived from the active trace
 * context into the supplied headers object. Mutates and returns the
 * object for convenience.
 *
 * No-op (returns headers unchanged) if no trace is active.
 *
 * Accepts both `Headers` (from fetch) and a plain dict.
 */
export function injectTraceparent<T extends HeadersLike>(headers: T): T {
  const state = getActiveTraceState();
  if (state === null) return headers;

  const traceId = state.traceId;
  const span =
    state.spanStack.length > 0
      ? state.spanStack[state.spanStack.length - 1]
      : state.completedSpans[state.completedSpans.length - 1];
  const rawSpanId = span?.span_id ?? traceId;

  setHeader(headers, W3C_TRACEPARENT_HEADER, buildTraceparent(traceId, rawSpanId));
  return headers;
}

/** Sampled flag for `traceId` per the configured sampler; sampled if it cannot be resolved. */
function resolveSampledFlag(traceId: string): string {
  try {
    return getOtelEngine().resolveSampled(traceId) ? W3C_FLAGS_SAMPLED : W3C_FLAGS_NOT_SAMPLED;
  } catch {
    return W3C_FLAGS_SAMPLED;
  }
}

/** The header value for a span: its OTel span id is the one the OTLP export gives it. */
function buildTraceparent(traceId: string, rawSpanId: string): string {
  return formatTraceparent(traceId, otelSpanIdFor(rawSpanId), resolveSampledFlag(traceId));
}

/* ------------------------------------------------------------------------ */
/*  Model-client calls (MHQ-1880)                                            */
/* ------------------------------------------------------------------------ */

let initPropagate: boolean | undefined;

/** `init({ propagateTraceContext })` hook; `undefined` leaves the env var to decide. */
export function setPropagateDefault(value: boolean | undefined): void {
  initPropagate = value;
}

/**
 * False when `MORSE_PROPAGATE_TRACE_CONTEXT` is `false`/`0`/`no`/`off` (Node only)
 * or `init({ propagateTraceContext: false })` was called.
 */
export function propagationEnabled(): boolean {
  try {
    if (typeof process !== "undefined" && process.env) {
      const raw = (process.env.MORSE_PROPAGATE_TRACE_CONTEXT ?? "").trim().toLowerCase();
      if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
    }
  } catch {
    // no process in this runtime: the env var cannot be set
  }
  return initPropagate !== false;
}

function hasTraceparentKey(keys: Iterable<unknown>): boolean {
  for (const k of keys) if (String(k).toLowerCase() === W3C_TRACEPARENT_HEADER) return true;
  return false;
}

/**
 * Copy of `existing` request headers with `traceparent` added, or `undefined`
 * when the caller already set one (never overwritten) or the shape is unknown.
 * Never mutates `existing`. Handles a plain object (null values are the model
 * SDKs' "remove this header" marker and count as set), `Headers`, and a tuple array.
 */
function withTraceparentHeader(existing: unknown, value: string): unknown | undefined {
  if (existing === undefined || existing === null) return { [W3C_TRACEPARENT_HEADER]: value };
  if (typeof Headers !== "undefined" && existing instanceof Headers) {
    if (existing.has(W3C_TRACEPARENT_HEADER)) return undefined;
    const copy = new Headers(existing);
    copy.set(W3C_TRACEPARENT_HEADER, value);
    return copy;
  }
  if (Array.isArray(existing)) {
    if (hasTraceparentKey(existing.map((pair) => (Array.isArray(pair) ? pair[0] : undefined)))) {
      return undefined;
    }
    return [...existing, [W3C_TRACEPARENT_HEADER, value]];
  }
  if (typeof existing === "object") {
    if (hasTraceparentKey(Object.keys(existing as object))) return undefined;
    return { ...(existing as Record<string, unknown>), [W3C_TRACEPARENT_HEADER]: value };
  }
  return undefined;
}

/**
 * Add a `traceparent` header to a model client's per-request options
 * (Anthropic / OpenAI Node SDKs take `(params, options)` with `options.headers`).
 *
 * `spanId` is the Morse span id of the `llm` span that records this call; the
 * header names it, and the OTLP export gives that span the same 64-bit id, so a
 * gateway that forwards the header produces a child of it. Returns new options;
 * the caller's options and headers are never mutated and a `traceparent` the
 * caller set is never replaced. No active trace, propagation disabled, or any
 * failure returns `callOptions` unchanged. Never throws.
 */
export function prepareLlmCall(
  callOptions: unknown,
  spanId: string | undefined,
  propagate: boolean = true,
): unknown {
  try {
    if (!propagate || !spanId || !propagationEnabled()) return callOptions;
    const state = getActiveTraceState();
    if (state === null) return callOptions;
    if (callOptions !== undefined && callOptions !== null && typeof callOptions !== "object") {
      return callOptions;
    }
    const base = (callOptions ?? {}) as { headers?: unknown };
    const headers = withTraceparentHeader(base.headers, buildTraceparent(state.traceId, spanId));
    if (headers === undefined) return callOptions;
    return { ...base, headers };
  } catch {
    return callOptions;
  }
}

export interface ExtractedContext {
  traceId: string;
  parentSpanId: string;
}

/**
 * Parse a W3C traceparent header and return `{ traceId, parentSpanId }`,
 * or `null` if the header is missing or malformed.
 *
 * Validation per W3C §3.2.3:
 *   - exactly 4 dash-separated fields
 *   - version === "00"
 *   - trace_id is 32 lowercase hex chars (and not all-zero)
 *   - span_id  is 16 lowercase hex chars (and not all-zero)
 */
export function extractTraceparent(
  headers: HeadersLike | string | null | undefined,
): ExtractedContext | null {
  if (headers === null || headers === undefined) return null;
  const raw = typeof headers === "string" ? headers : getHeader(headers, W3C_TRACEPARENT_HEADER);
  if (!raw) return null;
  const parts = raw.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId] = parts as [string, string, string, string];
  if (version !== W3C_VERSION) return null;
  if (traceId.length !== TRACE_ID_LEN) return null;
  if (spanId.length !== SPAN_ID_LEN) return null;
  if (!/^[0-9a-f]+$/.test(traceId)) return null;
  if (!/^[0-9a-f]+$/.test(spanId)) return null;
  if (/^0+$/.test(traceId)) return null;
  if (/^0+$/.test(spanId)) return null;
  return { traceId, parentSpanId: spanId };
}

/**
 * Convenience for Next.js API routes / generic HTTP servers: pull the
 * traceparent off an incoming Request (or a header bag).
 */
export function extractFromRequest(req: { headers: HeadersLike }): ExtractedContext | null {
  return extractTraceparent(req.headers);
}

/**
 * Convenience for outbound `fetch`: build a fresh `Headers` object with
 * the traceparent injected, layered on top of the caller's input.
 */
export function injectIntoRequestInit(init?: RequestInit): RequestInit {
  const merged = new Headers(init?.headers ?? {});
  injectTraceparent(merged);
  return { ...(init ?? {}), headers: merged };
}

/* ------------------------------------------------------------------------ */
/*  Header polymorphism helpers                                              */
/* ------------------------------------------------------------------------ */

export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null }
  | { [key: string]: unknown };

function getHeader(headers: HeadersLike, name: string): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  // Object that exposes get() — e.g., Node's IncomingMessage doesn't, but
  // Next.js's headers() does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maybeGet = (headers as any).get;
  if (typeof maybeGet === "function") {
    const v = maybeGet.call(headers, name);
    if (typeof v === "string") return v;
    if (v === null || v === undefined) return null;
  }
  // Plain dict: case-insensitive lookup.
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === "string") return v;
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0] as string;
      return null;
    }
  }
  return null;
}

function setHeader(headers: HeadersLike, name: string, value: string): void {
  if (headers instanceof Headers) {
    headers.set(name, value);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maybeSet = (headers as any).set;
  if (typeof maybeSet === "function") {
    maybeSet.call(headers, name, value);
    return;
  }
  (headers as Record<string, string>)[name] = value;
}
