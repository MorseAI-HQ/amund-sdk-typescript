/**
 * Span model — the wire format the SDK sends to Morse.
 *
 * Mirrors `apps/sdk/python/src/morse/spans.py` field-for-field. The
 * backend's `SpanType` choices are the source of truth.
 */

export const SpanType = {
  AGENT: "agent",
  LLM: "llm",
  TOOL: "tool",
  HTTP: "http",
  DB: "db",
  // MHQ-1404: auto-instrumented broker publish spans. Infra like db/http: non-billable
  // (ADR-033 D1) and never sets trace status. Matches Python `SpanType.QUEUE`.
  QUEUE: "queue",
  CUSTOM: "custom",
  MEMORY: "memory",
  // MHQ-482: matches Python's `SpanType.RETRIEVER` (apps/sdk/python/src/morse_ai/spans.py).
  // @beta — retriever span type is subject to change before SDK v1.0 (see
  // the plain-LangChain adapter's on_retriever_* callbacks in src/langchain/).
  RETRIEVER: "retriever",
  // MHQ-1025: matches Python's `SpanType.HANDOFF`. One span per routing
  // decision between two agents, with `from_agent` / `to_agent` metadata.
  HANDOFF: "handoff",
} as const;

export type SpanType = (typeof SpanType)[keyof typeof SpanType];

export type SpanStatus = "completed" | "failed" | "timed_out";

/**
 * Wire-format shape of one context segment carried on an LLM span.
 *
 * Mirrors the Python `morse.context.ContextSegmentDict` — keep both
 * sides in lockstep with the backend `ContextSegmentIn` Pydantic schema.
 *
 * - `tokens` is intentionally optional on the wire; the server tokenizes
 *   when omitted to keep client-side cost and dependency surface small.
 * - `source` accepts either underscored DB enum values (`memory_vector`)
 *   or the dotted public-API form (`memory.vector`); the server
 *   `normalize_segment_source` helper translates dots → underscores.
 */
export interface ContextSegment {
  position: number;
  source: string;
  content_hash: string;
  content?: string;
  content_truncated?: boolean;
  tokens?: number;
  tokens_estimated?: boolean;
  cache_state?: "cold" | "cache_write" | "cache_hit";
  attrs?: Record<string, unknown>;
  producer_span_id?: string;
}

export interface SpanData {
  trace_id: string;
  span_id: string;
  type: SpanType;
  name: string;
  parent_span_id?: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  status: SpanStatus;
  // LLM-specific
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  // Payload
  input_data?: unknown;
  output_data?: unknown;
  error_message?: string;
  /** Class name of the thrown error that failed this span (failure grouping). */
  exception_type?: string;
  metadata?: Record<string, unknown>;
  /**
   * Pre-segmented context profile (Anthropic / LangGraph adapters populate this).
   * `undefined` → server runs its messages-array classifier.
   * `[]`        → SDK explicitly says no segments (server skips classifier).
   * Populated   → server skips classification and persists as-is.
   */
  context_segments?: ContextSegment[];
}

export interface TraceFields {
  trace_id: string;
  /** Backend `TracePayloadIn.agent` — matches Python SDK + Pydantic schema. */
  agent: string;
  status: SpanStatus;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  error_message?: string;
  success?: boolean;
  outcome?: string;
}

export interface TraceEntry {
  trace: TraceFields;
  spans: SpanData[];
}

/** 32-char hex (128-bit). Compatible with W3C trace_id format. */
export function generateTraceId(): string {
  return randomHex(32);
}

/**
 * 32-char hex (UUID4-style, 128-bit). Matches the backend's UUID-typed
 * `span_id` column and the sibling Python SDK (`uuid.uuid4().hex`).
 *
 * When the SDK emits a W3C traceparent header (see `src/propagation.ts`),
 * the first 16 hex chars are sliced off to fit the W3C `span_id` slot —
 * that interop is handled at the header-formatting layer, not here.
 *
 * Was 16 hex chars historically (W3C span_id format) until Phase 13
 * Option A dogfood surfaced silent backend rejection: the dev ingest
 * `TracePayloadIn` schema requires UUID-shaped span_ids and was tossing
 * every TS-emitted span with `Invalid span_id format (expected UUID)`.
 */
export function generateSpanId(): string {
  return randomHex(32);
}

function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  // Use Web Crypto when available (Node 19+, all browsers).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoObj = (globalThis as any).crypto as Crypto | undefined;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    // Fallback: Math.random — non-cryptographic but acceptable for trace IDs.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex.slice(0, chars);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Serialize a SpanData, dropping undefined fields, matching Python's to_dict(). */
export function spanToWire(span: SpanData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(span)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

export function buildTraceEntry(
  fields: TraceFields,
  spans: SpanData[],
): { trace: TraceFields; spans: Record<string, unknown>[] } {
  return {
    trace: fields,
    spans: spans.map(spanToWire),
  };
}
