/**
 * `openai-agents/handoff.ts` — OpenAI Agents SDK handoff-span instrumentation.
 *
 * Subscribes to the Runner's "handoff" event channel and emits TWO spans per
 * handoff, matching the Python adapter:
 *
 * 1. The routing decision — wire `type = "handoff"` (MHQ-1025), named
 *    `from → to`, with `metadata.from_agent` / `metadata.to_agent` and
 *    `metadata.handoff_reason` when present. This is the navigable, timestamped
 *    node; before MHQ-1025 the decision itself had no span of its own.
 * 2. The handoff target — a `subagent.spawn`-shape span:
 *
 *   - wire `type = "agent"`
 *   - `metadata.spawn_kind = "subagent"`
 *   - `metadata.parent_agent_name = handoff.from_agent`
 *   - `metadata.subagent_name     = handoff.to_agent`
 *   - `metadata.handoff_from      = handoff.from_agent` (alias for UI clarity)
 *   - `metadata.askl_handoff_from = handoff.from_agent` — the key the server
 *     reads to derive a HANDS_OFF_TO edge rather than a SPAWNS one
 *     (`apps/api/apps/agents/selectors.py`); Python's adapter stamps the same.
 *   - `metadata.task_description  = handoff.reason` (via emitSubagentSpan)
 *   - `metadata.handoff_reason    = handoff.reason` (when present)
 *
 * The handoff event in the OpenAI Agents SDK is instantaneous — the to_agent's
 * subsequent work is captured by separate llm/tool spans (W2-O.2). Both spans
 * opened here are therefore closed immediately (duration_ms = 0).
 *
 * Errors emitted from inside the listener never propagate back to the runner —
 * `absorbErrorsSync` swallows them and `emitSubagentSpan` itself is wrapped.
 */

import { emitHandoffSpan, emitSubagentSpan } from "../_agent-sdk-common/span-emitter";
import { absorbErrorsSync } from "../_internal/errors";

import type { RunnerEventLike, RunnerLike } from "./types";

/* ------------------------------------------------------------------------ */
/*  Listener                                                                 */
/* ------------------------------------------------------------------------ */

const _handleHandoffEvent = (event: RunnerEventLike): void => {
  if (event === null || typeof event !== "object") return;
  const handoff = event.handoff;
  if (!handoff || typeof handoff !== "object") return;
  const from = handoff.from_agent;
  const to = handoff.to_agent;
  if (typeof from !== "string" || from.length === 0) return;
  if (typeof to !== "string" || to.length === 0) return;
  const reason =
    typeof handoff.reason === "string" && handoff.reason.length > 0 ? handoff.reason : undefined;
  // 1. The routing decision itself, closed immediately — a handoff is an
  //    instant, not an interval.
  emitHandoffSpan({
    adapter: "openai-agents",
    fromAgent: from,
    toAgent: to,
    reason,
  })?.end();
  // 2. The target agent, so it stays a node in the orchestration tree.
  const attributes: Record<string, unknown> = {
    handoff_from: from,
    askl_handoff_from: from,
  };
  if (reason !== undefined) attributes.handoff_reason = reason;
  const handle = emitSubagentSpan({
    adapter: "openai-agents",
    parentAgentName: from,
    subagentName: to,
    taskDescription: reason,
    attributes,
  });
  // The handoff event is instantaneous; close the span immediately so the
  // to_agent's subsequent work is captured as separate sibling spans (not
  // children of an open handoff span).
  handle?.end();
};

const handleHandoffEvent: (event: RunnerEventLike) => void = absorbErrorsSync(_handleHandoffEvent, {
  fingerprint: "morse.adapters.openai-agents.handoff.listener",
}) as (event: RunnerEventLike) => void;

/* ------------------------------------------------------------------------ */
/*  Installer                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Subscribe to a Runner's "handoff" events and emit a `subagent.spawn`-shape
 * span for each. Returns an unsubscribe function. Safely no-ops when
 * `runner.on` is missing (e.g., a wrapped Runner without an event channel).
 */
export function installHandoffInstrumentation(runner: RunnerLike): () => void {
  if (runner === null || typeof runner !== "object") return () => {};
  if (typeof runner.on !== "function") return () => {};
  try {
    runner.on("handoff", handleHandoffEvent);
  } catch {
    // Defensive: a misbehaving on() implementation must not break the caller.
    return () => {};
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    try {
      runner.off?.("handoff", handleHandoffEvent);
    } catch {
      // never propagate
    }
  };
}
