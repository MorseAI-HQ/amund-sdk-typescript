/**
 * Context propagation helpers shared by the agent-SDK adapters
 * (Anthropic Agent SDK, OpenAI Agents SDK, LangGraph).
 *
 * The default `startSpan()` parent-linkage strategy in `_internal/tracing`
 * always picks the top of the active `spanStack` as the parent. That
 * works for synchronous, well-nested workflows but breaks for two common
 * agent-SDK patterns:
 *
 *   1. **Fan-out** — Anthropic's Task tool and OpenAI's handoffs spawn N
 *      children that run concurrently. The default top-of-stack lookup
 *      sees whichever sibling started most recently, not the shared
 *      parent agent span. We capture the parent ID at fan-out time and
 *      pin every child's `parent_span_id` to that snapshot.
 *
 *   2. **Hook siblings** — `pre_tool` / `post_tool` hooks logically sit
 *      next to the `tool` span they bracket, not nested under it. We
 *      look up the tool span (open or completed) and reuse its
 *      `parent_span_id` for the hook span.
 *
 * All public functions are wrapped in `absorbErrorsSync` so a malformed
 * snapshot or unexpected runtime state can never escape into the host
 * application.
 */

import { absorbErrorsSync } from "../_internal/errors";
import type { SpanData, SpanType } from "../_internal/spans";
import {
  getActiveTraceState,
  startSpan,
  type SpanHandle,
  type TraceState,
} from "../_internal/tracing";

export interface ParentSnapshot {
  parentSpanId: string;
  traceId: string;
}

export interface EmitWithPinnedParentOptions {
  name: string;
  type: SpanType;
  metadata?: Record<string, unknown>;
  snapshot: ParentSnapshot;
}

export interface EmitAsToolSiblingOptions {
  name: string;
  type: SpanType;
  metadata?: Record<string, unknown>;
  toolSpanId: string;
}

export interface TraceStateSnapshot {
  traceId: string;
  spanStack: ReadonlyArray<SpanData>;
  completedSpans: ReadonlyArray<SpanData>;
}

/**
 * Snapshot the current parent span (top of `spanStack`) so child spans
 * emitted later — possibly after the parent has moved off the stack —
 * can be linked explicitly via `parent_span_id`.
 *
 * Returns `null` if there is no active trace or the stack is empty.
 */
export const captureParentForFanOut = absorbErrorsSync(
  (): ParentSnapshot | null => {
    const state = getActiveTraceState();
    if (state === null) return null;
    const top = state.spanStack[state.spanStack.length - 1];
    if (!top) return null;
    return {
      parentSpanId: top.span_id,
      traceId: state.traceId,
    };
  },
  { fingerprint: "agent-sdk-common.captureParentForFanOut" },
) as () => ParentSnapshot | null;

/**
 * Emit a span linked to a previously captured parent (from
 * `captureParentForFanOut`). The span is started/ended via the normal
 * tracing lifecycle but its `parent_span_id` is forced to the snapshot
 * rather than the current top-of-stack.
 *
 * Returns `null` if there is no active trace or the snapshot's
 * `traceId` doesn't match the active trace.
 */
export const emitWithPinnedParent = absorbErrorsSync(
  (opts: EmitWithPinnedParentOptions): SpanHandle | null => {
    const state = getActiveTraceState();
    if (state === null) return null;
    const snap = opts.snapshot;
    if (!snap || snap.traceId !== state.traceId) return null;

    const handle = startSpan({
      name: opts.name,
      type: opts.type,
      metadata: opts.metadata,
    });
    if (handle === null) return null;
    handle.span.parent_span_id = snap.parentSpanId;
    return handle;
  },
  { fingerprint: "agent-sdk-common.emitWithPinnedParent" },
) as (opts: EmitWithPinnedParentOptions) => SpanHandle | null;

function findSpanById(state: TraceState, spanId: string): SpanData | undefined {
  for (let i = state.spanStack.length - 1; i >= 0; i--) {
    const s = state.spanStack[i];
    if (s && s.span_id === spanId) return s;
  }
  for (let i = state.completedSpans.length - 1; i >= 0; i--) {
    const s = state.completedSpans[i];
    if (s && s.span_id === spanId) return s;
  }
  return undefined;
}

/**
 * Emit a span as a sibling of a specific tool span — i.e. attach it to
 * the same parent as the tool, not nested inside the tool. Used by
 * `pre_tool` / `post_tool` hook spans.
 *
 * Looks up the tool span in `spanStack` (still open) then
 * `completedSpans` (already closed). Returns `null` if the tool span
 * cannot be found in the current trace.
 */
export const emitAsToolSibling = absorbErrorsSync(
  (opts: EmitAsToolSiblingOptions): SpanHandle | null => {
    const state = getActiveTraceState();
    if (state === null) return null;
    const tool = findSpanById(state, opts.toolSpanId);
    if (!tool) return null;

    const handle = startSpan({
      name: opts.name,
      type: opts.type,
      metadata: opts.metadata,
    });
    if (handle === null) return null;
    // `parent_span_id` may be undefined if the tool itself was a root
    // child of the trace's agent span only — propagate that as-is.
    handle.span.parent_span_id = tool.parent_span_id;
    return handle;
  },
  { fingerprint: "agent-sdk-common.emitAsToolSibling" },
) as (opts: EmitAsToolSiblingOptions) => SpanHandle | null;

/**
 * Read-only inspector for adapter-side debugging and tests. Returns a
 * shallow copy of the current `spanStack` and `completedSpans` plus the
 * active `traceId`, or `null` if there is no active trace.
 */
export const inspectTraceState = absorbErrorsSync(
  (): TraceStateSnapshot | null => {
    const state = getActiveTraceState();
    if (state === null) return null;
    return {
      traceId: state.traceId,
      spanStack: state.spanStack.slice(),
      completedSpans: state.completedSpans.slice(),
    };
  },
  { fingerprint: "agent-sdk-common.inspectTraceState" },
) as () => TraceStateSnapshot | null;
