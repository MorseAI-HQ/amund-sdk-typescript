/**
 * `_agent-sdk-common/span-emitter.ts` — shared span-emission helpers used by
 * all three agent-SDK adapters (`anthropic-agent-sdk`, `openai-agents`,
 * `langgraph-js`).
 *
 * Each helper:
 *
 *   1. Validates the required metadata for its logical span type.
 *   2. Calls `startSpan(...)` from `_internal/tracing.ts` to allocate the
 *      wire-format span and push it onto the active trace's span stack.
 *   3. Tags `metadata.adapter` on every span so the UI can attribute spans
 *      back to their adapter origin.
 *   4. Hydrates type-specific top-level fields (`model`, `input_tokens`,
 *      `output_tokens`, `total_tokens`, `context_segments`) onto `SpanData`.
 *   5. Returns the `SpanHandle` so callers can later call `.end(err?)`.
 *
 * All helpers are wrapped in `absorbErrorsSync` — telemetry MUST NOT throw
 * at the caller. If `startSpan` returns `null` (no active trace), the
 * helper also returns `null`; callers must tolerate this case.
 *
 * Logical → wire `type` mapping (per `design.md` §Span schema):
 *
 *   agent     → "agent"
 *   llm       → "llm"
 *   tool      → "tool"
 *   subagent  → "agent" + metadata.spawn_kind = "subagent"
 *   hook      → "tool"  + metadata.tool_kind  = "hook"
 *   handoff   → "handoff" (native since MHQ-1025 — no metadata stand-in)
 *
 * Adapter-flavoured redaction (tool-arg truncation, base64/image
 * stripping) lives in a sibling `redaction.ts` (W1.2). This file is
 * intentionally agnostic: the only redaction it applies is a minimal
 * string-length guard on free-form fields that would otherwise blow up
 * the wire payload (task descriptions, hook names, tool names).
 */

import { absorbErrorsSync } from "../_internal/errors";
import type { ContextSegment, SpanData } from "../_internal/spans";
import { startSpan, type SpanHandle } from "../_internal/tracing";

/* ------------------------------------------------------------------------ */
/*  Public types                                                             */
/* ------------------------------------------------------------------------ */

export type AdapterName = "anthropic-agent-sdk" | "openai-agents" | "langgraph-js" | "vercel-ai";

/** Soft cap for free-form identifier-ish strings (tool names, hook names, etc.). */
const MAX_NAME_BYTES = 256;

/** Soft cap for free-form description strings (task descriptions). */
const MAX_DESCRIPTION_BYTES = 2048;

/** Trim a string to `maxBytes` bytes (UTF-8 codepoint-safe at the JS-string level). */
function truncate(value: string, maxBytes: number): string {
  if (value.length <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}…[truncated]`;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`morse span-emitter: ${field} must be a non-empty string`);
  }
  return value;
}

/* ------------------------------------------------------------------------ */
/*  emitAgentSpan                                                            */
/* ------------------------------------------------------------------------ */

export interface EmitAgentSpanOptions {
  adapter: AdapterName;
  agentName: string;
  model?: string;
  attributes?: Record<string, unknown>;
}

const _emitAgentSpan = (opts: EmitAgentSpanOptions): SpanHandle | null => {
  const adapter = requireNonEmpty(opts.adapter, "adapter");
  const agentName = requireNonEmpty(opts.agentName, "agentName");
  const metadata: Record<string, unknown> = {
    ...(opts.attributes ?? {}),
    adapter,
    agent_name: agentName,
  };
  const handle = startSpan({
    name: `${adapter}.agent`,
    type: "agent",
    metadata,
  });
  if (handle === null) return null;
  if (typeof opts.model === "string" && opts.model.length > 0) {
    handle.span.model = opts.model;
    metadata.model = opts.model;
  }
  return handle;
};

/**
 * Emit a wire `type=agent` span. Returns `null` when no active trace exists
 * (callers MUST tolerate this); never throws.
 */
export const emitAgentSpan: (opts: EmitAgentSpanOptions) => SpanHandle | null = absorbErrorsSync(
  _emitAgentSpan,
  {
    fingerprint: "morse.adapters.shared.emitAgentSpan",
  },
) as (opts: EmitAgentSpanOptions) => SpanHandle | null;

/* ------------------------------------------------------------------------ */
/*  emitChainSpan                                                            */
/* ------------------------------------------------------------------------ */

export interface EmitChainSpanOptions {
  adapter: AdapterName;
  name: string;
  attributes?: Record<string, unknown>;
}

/**
 * AID-02: a framework-internal node (graph node, runnable, task, turn) is a span, never
 * an agent. The wire has no `chain` span type, so this is `type=custom` with
 * `metadata.span_kind="chain"`; it nests under the real agent. Returns `null` when no
 * trace is active; never throws.
 */
export const emitChainSpan: (opts: EmitChainSpanOptions) => SpanHandle | null = absorbErrorsSync(
  (opts: EmitChainSpanOptions): SpanHandle | null =>
    startSpan({
      name: requireNonEmpty(opts.name, "name"),
      type: "custom",
      metadata: { ...(opts.attributes ?? {}), adapter: opts.adapter, span_kind: "chain" },
    }),
  { fingerprint: "morse.adapters.shared.emitChainSpan" },
) as (opts: EmitChainSpanOptions) => SpanHandle | null;

/* ------------------------------------------------------------------------ */
/*  emitLlmSpan                                                              */
/* ------------------------------------------------------------------------ */

export interface EmitLlmSpanOptions {
  adapter: AdapterName;
  model: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextSegments?: ContextSegment[];
  attributes?: Record<string, unknown>;
  // MHQ-858: prompt/response capture. Adapters pass already-truncated
  // values (see `_internal/llm-io.ts`); this emitter does not truncate.
  inputData?: unknown;
  outputData?: unknown;
}

const _emitLlmSpan = (opts: EmitLlmSpanOptions): SpanHandle | null => {
  const adapter = requireNonEmpty(opts.adapter, "adapter");
  const model = requireNonEmpty(opts.model, "model");
  const metadata: Record<string, unknown> = {
    ...(opts.attributes ?? {}),
    adapter,
    model,
  };
  if (typeof opts.provider === "string" && opts.provider.length > 0) {
    metadata.provider = opts.provider;
  }
  const handle = startSpan({
    name: `${adapter}.llm`,
    type: "llm",
    metadata,
  });
  if (handle === null) return null;
  const span: SpanData = handle.span;
  span.model = model;
  if (typeof opts.inputTokens === "number" && Number.isFinite(opts.inputTokens)) {
    span.input_tokens = opts.inputTokens;
  }
  if (typeof opts.outputTokens === "number" && Number.isFinite(opts.outputTokens)) {
    span.output_tokens = opts.outputTokens;
  }
  if (typeof opts.totalTokens === "number" && Number.isFinite(opts.totalTokens)) {
    span.total_tokens = opts.totalTokens;
  } else if (span.input_tokens !== undefined && span.output_tokens !== undefined) {
    span.total_tokens = span.input_tokens + span.output_tokens;
  }
  if (Array.isArray(opts.contextSegments)) {
    span.context_segments = opts.contextSegments;
  }
  if (opts.inputData !== undefined) span.input_data = opts.inputData;
  if (opts.outputData !== undefined) span.output_data = opts.outputData;
  return handle;
};

/**
 * Emit a wire `type=llm` span. Returns `null` when no active trace exists;
 * never throws. Hydrates `model`, `input_tokens`, `output_tokens`,
 * `total_tokens` (derived if absent), and `context_segments` onto the
 * underlying `SpanData` so downstream consumers see them at the top level
 * — not buried in `metadata`.
 */
export const emitLlmSpan: (opts: EmitLlmSpanOptions) => SpanHandle | null = absorbErrorsSync(
  _emitLlmSpan,
  {
    fingerprint: "morse.adapters.shared.emitLlmSpan",
  },
) as (opts: EmitLlmSpanOptions) => SpanHandle | null;

/* ------------------------------------------------------------------------ */
/*  emitToolSpan                                                             */
/* ------------------------------------------------------------------------ */

export interface EmitToolSpanOptions {
  adapter: AdapterName;
  toolName: string;
  inputSummary?: unknown;
  outputSummary?: unknown;
  durationMs?: number;
  success?: boolean;
  attributes?: Record<string, unknown>;
}

const _emitToolSpan = (opts: EmitToolSpanOptions): SpanHandle | null => {
  const adapter = requireNonEmpty(opts.adapter, "adapter");
  const toolName = truncate(requireNonEmpty(opts.toolName, "toolName"), MAX_NAME_BYTES);
  const tool: Record<string, unknown> = { name: toolName };
  if (opts.inputSummary !== undefined) tool.input_summary = opts.inputSummary;
  if (opts.outputSummary !== undefined) tool.output_summary = opts.outputSummary;
  if (typeof opts.durationMs === "number" && Number.isFinite(opts.durationMs)) {
    tool.duration_ms = opts.durationMs;
  }
  if (typeof opts.success === "boolean") tool.success = opts.success;
  const metadata: Record<string, unknown> = {
    ...(opts.attributes ?? {}),
    adapter,
    tool,
  };
  return startSpan({
    name: `${adapter}.tool.${toolName}`,
    type: "tool",
    metadata,
  });
};

/**
 * Emit a wire `type=tool` span. Returns `null` when no active trace exists;
 * never throws.
 */
export const emitToolSpan: (opts: EmitToolSpanOptions) => SpanHandle | null = absorbErrorsSync(
  _emitToolSpan,
  {
    fingerprint: "morse.adapters.shared.emitToolSpan",
  },
) as (opts: EmitToolSpanOptions) => SpanHandle | null;

/* ------------------------------------------------------------------------ */
/*  emitSubagentSpan                                                         */
/* ------------------------------------------------------------------------ */

export interface EmitSubagentSpanOptions {
  adapter: AdapterName;
  parentAgentName: string;
  subagentName: string;
  taskDescription?: string;
  attributes?: Record<string, unknown>;
}

const _emitSubagentSpan = (opts: EmitSubagentSpanOptions): SpanHandle | null => {
  const adapter = requireNonEmpty(opts.adapter, "adapter");
  const parentAgentName = requireNonEmpty(opts.parentAgentName, "parentAgentName");
  const subagentName = requireNonEmpty(opts.subagentName, "subagentName");
  const metadata: Record<string, unknown> = {
    ...(opts.attributes ?? {}),
    adapter,
    spawn_kind: "subagent",
    parent_agent_name: parentAgentName,
    subagent_name: subagentName,
  };
  if (typeof opts.taskDescription === "string" && opts.taskDescription.length > 0) {
    metadata.task_description = truncate(opts.taskDescription, MAX_DESCRIPTION_BYTES);
  }
  return startSpan({
    name: `${adapter}.subagent.${subagentName}`,
    type: "agent",
    metadata,
  });
};

/**
 * Emit a wire `type=agent` span with `metadata.spawn_kind="subagent"` — the
 * UI inspects this metadata key to render subagent-spawn relationships
 * until the backend gains a native `subagent` enum value. Returns `null`
 * when no active trace exists; never throws.
 */
export const emitSubagentSpan: (opts: EmitSubagentSpanOptions) => SpanHandle | null =
  absorbErrorsSync(_emitSubagentSpan, {
    fingerprint: "morse.adapters.shared.emitSubagentSpan",
  }) as (opts: EmitSubagentSpanOptions) => SpanHandle | null;

/* ------------------------------------------------------------------------ */
/*  emitHandoffSpan                                                          */
/* ------------------------------------------------------------------------ */

export interface EmitHandoffSpanOptions {
  adapter: AdapterName;
  fromAgent: string;
  toAgent: string;
  reason?: string;
  attributes?: Record<string, unknown>;
}

const _emitHandoffSpan = (opts: EmitHandoffSpanOptions): SpanHandle | null => {
  const adapter = requireNonEmpty(opts.adapter, "adapter");
  const fromAgent = truncate(requireNonEmpty(opts.fromAgent, "fromAgent"), MAX_NAME_BYTES);
  const toAgent = truncate(requireNonEmpty(opts.toAgent, "toAgent"), MAX_NAME_BYTES);
  const metadata: Record<string, unknown> = {
    ...(opts.attributes ?? {}),
    adapter,
    from_agent: fromAgent,
    to_agent: toAgent,
  };
  if (typeof opts.reason === "string" && opts.reason.length > 0) {
    metadata.handoff_reason = truncate(opts.reason, MAX_DESCRIPTION_BYTES);
  }
  return startSpan({
    name: `${fromAgent} → ${toAgent}`,
    type: "handoff",
    metadata,
  });
};

/**
 * Emit a native wire `type=handoff` span for one routing decision between two
 * agents (MHQ-1025). Mirrors the Python SDK: name `from → to`, metadata
 * `{from_agent, to_agent}`. Returns `null` when no active trace exists; never
 * throws.
 */
export const emitHandoffSpan: (opts: EmitHandoffSpanOptions) => SpanHandle | null =
  absorbErrorsSync(_emitHandoffSpan, {
    fingerprint: "morse.adapters.shared.emitHandoffSpan",
  }) as (opts: EmitHandoffSpanOptions) => SpanHandle | null;

/* ------------------------------------------------------------------------ */
/*  emitHookSpan                                                             */
/* ------------------------------------------------------------------------ */

export interface EmitHookSpanOptions {
  adapter: AdapterName;
  hookName: string;
  hookKind: "pre_tool" | "post_tool" | "on_error";
  durationMs?: number;
  attributes?: Record<string, unknown>;
}

const _emitHookSpan = (opts: EmitHookSpanOptions): SpanHandle | null => {
  const adapter = requireNonEmpty(opts.adapter, "adapter");
  const hookName = truncate(requireNonEmpty(opts.hookName, "hookName"), MAX_NAME_BYTES);
  const hookKind = opts.hookKind;
  if (hookKind !== "pre_tool" && hookKind !== "post_tool" && hookKind !== "on_error") {
    throw new Error(
      `morse span-emitter: hookKind must be one of pre_tool|post_tool|on_error (got ${String(
        hookKind,
      )})`,
    );
  }
  const hook: Record<string, unknown> = { name: hookName, kind: hookKind };
  if (typeof opts.durationMs === "number" && Number.isFinite(opts.durationMs)) {
    hook.duration_ms = opts.durationMs;
  }
  const metadata: Record<string, unknown> = {
    ...(opts.attributes ?? {}),
    adapter,
    tool_kind: "hook",
    hook,
  };
  return startSpan({
    name: `${adapter}.hook.${hookKind}.${hookName}`,
    type: "tool",
    metadata,
  });
};

/**
 * Emit a wire `type=tool` span with `metadata.tool_kind="hook"` — the UI
 * inspects this metadata key to render hook spans separately from regular
 * tool spans. Returns `null` when no active trace exists; never throws.
 */
export const emitHookSpan: (opts: EmitHookSpanOptions) => SpanHandle | null = absorbErrorsSync(
  _emitHookSpan,
  {
    fingerprint: "morse.adapters.shared.emitHookSpan",
  },
) as (opts: EmitHookSpanOptions) => SpanHandle | null;
