/**
 * W3C Trace Context propagation — inject and extract `traceparent` headers.
 *
 * W3C traceparent format: `{version}-{trace_id}-{span_id}-{flags}`
 *   - version  : "00" (fixed)
 *   - trace_id : 32 lowercase hex chars (128-bit)
 *   - span_id  : 16 lowercase hex chars (64-bit)
 *   - flags    : "01" (sampled, always set for Morse)
 *
 * Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 *
 * References:
 *   https://www.w3.org/TR/trace-context/
 */

import { getActiveTraceState } from "./_internal/tracing";

export const W3C_TRACEPARENT_HEADER = "traceparent";
export const W3C_VERSION = "00";
export const W3C_FLAGS_SAMPLED = "01";

const TRACE_ID_LEN = 32;
const SPAN_ID_LEN = 16;

/**
 * Build a W3C traceparent value from explicit IDs.
 *
 * Useful when you have a trace_id / span_id from somewhere other than
 * the active context (e.g., re-emitting an upstream trace's IDs).
 */
export function formatTraceparent(traceId: string, spanId: string): string {
  // We trust the caller; the "build then validate" assumption is documented.
  const tid = traceId.slice(0, TRACE_ID_LEN).padStart(TRACE_ID_LEN, "0").toLowerCase();
  const sid = spanId.slice(0, SPAN_ID_LEN).padStart(SPAN_ID_LEN, "0").toLowerCase();
  return `${W3C_VERSION}-${tid}-${sid}-${W3C_FLAGS_SAMPLED}`;
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
  const spanId = rawSpanId.slice(0, SPAN_ID_LEN);

  const value = formatTraceparent(traceId, spanId);
  setHeader(headers, W3C_TRACEPARENT_HEADER, value);
  return headers;
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
