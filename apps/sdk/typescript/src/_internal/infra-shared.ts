/**
 * Shared pieces of default-on infra capture (INFRACAP-03/04/05), used by the DB,
 * HTTP and queue captures. Browser-safe on purpose (no Node imports) so
 * `tracing.ts` types stay importable everywhere; the Node-only callers are
 * stubbed out of the browser build.
 */

import {
  context as otelContext,
  trace as traceApi,
  type Context,
  type Span,
  type SpanOptions as OtelSpanOptions,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";

import type { SpanData, SpanType } from "./spans";
import { generateSpanId, nowIso } from "./spans";
import { getActiveTraceState } from "./tracing";

/* ------------------------------------------------------------------------ */
/*  Per-trace caps (INFRACAP-04)                                             */
/* ------------------------------------------------------------------------ */

export type InfraKind = "db" | "http" | "queue";

/** Spans kept per trace, per kind, before collapsing into one summary span. */
export const INFRA_CAPS: Record<InfraKind, number> = { db: 200, http: 100, queue: 100 };

const SUMMARY_TYPE: Record<InfraKind, SpanType> = { db: "db", http: "http", queue: "custom" };

/**
 * Count one call of `kind` against the active trace.
 *
 * Returns true when a span may be recorded. Returns false when there is no
 * active trace (INFRACAP-03) or the trace is past the cap; in the second case
 * the call is folded into the trace's single summary span for that kind.
 */
export function admitInfraCall(kind: InfraKind): boolean {
  const state = getActiveTraceState();
  if (state === null) return false;
  const counts = (state.infraCounts ??= {});
  const n = counts[kind] ?? 0;
  const cap = INFRA_CAPS[kind];
  if (n < cap) {
    counts[kind] = n + 1;
    return true;
  }
  const summaries = (state.infraSummaries ??= {});
  let summary = summaries[kind];
  if (summary === undefined) {
    const parent = state.spanStack[state.spanStack.length - 1];
    const now = nowIso();
    summary = {
      trace_id: state.traceId,
      span_id: generateSpanId(),
      type: SUMMARY_TYPE[kind],
      name: kind,
      parent_span_id: parent?.span_id,
      started_at: now,
      ended_at: now,
      duration_ms: 0,
      status: "completed",
      metadata: { "infra.suppressed_count": 0, "infra.cap": cap },
    };
    summaries[kind] = summary;
    state.completedSpans.push(summary);
  }
  const meta = summary.metadata as Record<string, number>;
  const suppressed = (meta["infra.suppressed_count"] ?? 0) + 1;
  meta["infra.suppressed_count"] = suppressed;
  summary.name = `+${suppressed} more ${kind} calls (capped at ${cap})`;
  return false;
}

/**
 * Failure text for a span: the error code or class, never the message. Node and
 * undici put the target (and sometimes the URL) into error messages.
 */
export function errorLabel(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown } | null;
  if (typeof e?.code === "string") return e.code;
  if (typeof e?.name === "string") return e.name;
  return "Error";
}

/* ------------------------------------------------------------------------ */
/*  SQL literal scrubbing (INFRACAP-05)                                      */
/* ------------------------------------------------------------------------ */

// One left-to-right pass so a quote inside a comment, or `--` inside a string,
// is read in the right context. Mirrors Python's `infra_capture.scrub_sql`.
const SQL_TOKEN = new RegExp(
  [
    String.raw`\$([A-Za-z_]\w*|)\$[\s\S]*?\$\1\$`, // $$..$$ / $tag$..$tag$
    String.raw`(?<![A-Za-z0-9_])[EeNnXxBb]?'(?:[^'\\]|\\[\s\S]|'')*'`, // 'abc', E'a\'b', N'x'
    String.raw`--[^\n]*`,
    String.raw`/\*[\s\S]*?\*/`,
    String.raw`0[xX][0-9A-Fa-f]+`,
    String.raw`(?<![\w.$:@#])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?!\w)`,
  ].join("|"),
  "g",
);

const SCRUB_CACHE = new Map<string, string>();
const SCRUB_CACHE_MAX = 512;
const MAX_STATEMENT_CHARS = 2048;
const TRUNCATION_MARKER = "…[truncated]";

/**
 * Replace literal values written inline in SQL (strings, numbers, hex,
 * dollar-quoted bodies) with `?` and drop comments. Placeholders (`$1`, `?`,
 * `:name`) are kept. Bound parameters are never seen here.
 */
export function scrubSql(statement: string): string {
  const cached = SCRUB_CACHE.get(statement);
  if (cached !== undefined) return cached;
  const input =
    statement.length > MAX_STATEMENT_CHARS * 8
      ? statement.slice(0, MAX_STATEMENT_CHARS * 8)
      : statement;
  let out = input.replace(SQL_TOKEN, (m) => (m.startsWith("--") || m.startsWith("/*") ? "" : "?"));
  // A quote that survived is an unterminated string. Everything after it is
  // string content, so drop it rather than risk leaking it.
  const cut = out.indexOf("'");
  if (cut !== -1) out = out.slice(0, cut) + "?";
  if (SCRUB_CACHE.size >= SCRUB_CACHE_MAX) SCRUB_CACHE.clear();
  SCRUB_CACHE.set(statement, out);
  return out;
}

/** Scrubbed, trimmed, length-capped statement for a span attribute; undefined if empty. */
export function safeStatement(sql: unknown): string | undefined {
  let text: string;
  try {
    text = scrubSql(String(sql).trim()).trim();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  if (text.length > MAX_STATEMENT_CHARS) {
    return text.slice(0, MAX_STATEMENT_CHARS) + " " + TRUNCATION_MARKER;
  }
  return text;
}

const STATEMENT_KEYS = ["db.query.text", "db.statement"];
const PARAMETER_PREFIXES = ["db.query.parameter.", "db.operation.parameter."];

/**
 * Last-line scrub for DB span attributes, applied at export to every span no
 * matter which instrumentation produced it: inline literals in the statement
 * become `?`, and any bound-parameter attribute is removed. Mutates in place.
 */
export function scrubDbAttributes(attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const key of STATEMENT_KEYS) {
    const v = attrs[key];
    if (typeof v === "string") {
      const clean = safeStatement(v);
      if (clean === undefined) delete attrs[key];
      else attrs[key] = clean;
    }
  }
  for (const key of Object.keys(attrs)) {
    if (PARAMETER_PREFIXES.some((p) => key.startsWith(p))) delete attrs[key];
  }
}

/**
 * Scrub a finished DB span at export (`RedactingSpanExporter`): attributes via
 * `scrubDbAttributes`, plus the failure text. Driver error messages routinely
 * carry row values (Postgres `DETAIL: Key (email)=(a@b.com) already exists`),
 * so the exception message, its stack and the status message are dropped and
 * only the exception type is kept. Non-DB spans are left alone.
 */
export function scrubDbSpan(span: {
  attributes?: Record<string, unknown>;
  events?: Array<{ attributes?: Record<string, unknown> }>;
  status?: { message?: string };
}): void {
  const attrs = span.attributes;
  if (!attrs) return;
  if (attrs["db.system"] === undefined && attrs["db.system.name"] === undefined) return;
  scrubDbAttributes(attrs);
  for (const event of span.events ?? []) {
    const ev = event.attributes;
    if (!ev) continue;
    delete ev["exception.message"];
    delete ev["exception.stacktrace"];
  }
  if (span.status && span.status.message !== undefined) span.status.message = undefined;
}

/* ------------------------------------------------------------------------ */
/*  Trace gate for OTel-based instrumentations (INFRACAP-03/04)              */
/* ------------------------------------------------------------------------ */

function nonRecordingSpan(): Span {
  return traceApi.wrapSpanContext({ traceId: "", spanId: "", traceFlags: 0 });
}

class GatedTracer implements Tracer {
  constructor(
    private readonly inner: Tracer,
    private readonly kind: InfraKind,
  ) {}

  startSpan(name: string, options?: OtelSpanOptions, ctx?: Context): Span {
    if (!admitInfraCall(this.kind)) return nonRecordingSpan();
    return this.inner.startSpan(name, options, ctx);
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: OtelSpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: OtelSpanOptions,
    ctx: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan(name: string, a: unknown, b?: unknown, c?: unknown): unknown {
    let options: OtelSpanOptions | undefined;
    let ctx: Context | undefined;
    let fn: (span: Span) => unknown;
    if (typeof a === "function") {
      fn = a as (span: Span) => unknown;
    } else if (typeof b === "function") {
      options = a as OtelSpanOptions;
      fn = b as (span: Span) => unknown;
    } else {
      options = a as OtelSpanOptions;
      ctx = b as Context;
      fn = c as (span: Span) => unknown;
    }
    const span = this.startSpan(name, options, ctx);
    const withSpan = traceApi.setSpan(ctx ?? otelContext.active(), span);
    return otelContext.with(withSpan, fn, undefined, span);
  }
}

/**
 * Wrap a `TracerProvider` so every instrumentation handed to it only produces
 * a span while a Morse trace is active and under the per-trace cap. The
 * community pg / mysql2 instrumentations otherwise create an orphan root span
 * for a query made outside any trace, and have no cap.
 */
export function gateTracerProvider(inner: TracerProvider, kind: InfraKind): TracerProvider {
  return {
    getTracer: (name, version, options) =>
      new GatedTracer(inner.getTracer(name, version, options), kind),
  };
}

/** @internal test hook */
export function _resetInfraSharedForTesting(): void {
  SCRUB_CACHE.clear();
}

export type { SpanData };
