/**
 * `openai-agents/guardrail.ts` — W2-O.4
 *
 * Subscribes to the `Runner`'s `"guardrail_check"` event channel and emits
 * one guardrail-shaped span per check. Guardrails are wire-`tool` spans
 * tagged with `metadata.tool_kind="guardrail"` so the dashboard can render
 * them distinctly from regular tool calls and hook spans.
 *
 * Spans close immediately on emission. When the guardrail reports
 * `passed === false`, the span closes with `failed` status and the
 * reason (when present) lands in both the synthetic error message and
 * `metadata.guardrail.reason`.
 *
 * Every emission is wrapped in `absorbErrorsSync` per the foundational
 * "telemetry must never break the host" guarantee.
 */

import { absorbErrorsSync } from "../_internal/errors";
import { emitToolSpan } from "../_agent-sdk-common/span-emitter";
import type { RunnerEventLike, RunnerLike } from "./types";

/* ------------------------------------------------------------------------ */
/*  Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

const _handleGuardrailEvent = (payload: RunnerEventLike): void => {
  const guardrail = payload?.guardrail;
  if (guardrail === undefined || guardrail === null || typeof guardrail !== "object") {
    return;
  }

  const name =
    typeof guardrail.name === "string" && guardrail.name.length > 0 ? guardrail.name : undefined;
  const passed = guardrail.passed === true;
  const reason =
    typeof guardrail.reason === "string" && guardrail.reason.length > 0
      ? guardrail.reason
      : undefined;

  const guardrailMeta: Record<string, unknown> = { passed };
  if (name !== undefined) guardrailMeta.name = name;
  if (reason !== undefined) guardrailMeta.reason = reason;

  const handle = emitToolSpan({
    adapter: "openai-agents",
    toolName: `guardrail.${name ?? "anon"}`,
    success: passed,
  });
  if (handle === null || handle === undefined) return;

  // Apply guardrail-specific metadata on top of what emitToolSpan set.
  handle.span.metadata = {
    ...(handle.span.metadata ?? {}),
    tool_kind: "guardrail",
    guardrail: guardrailMeta,
  };

  if (passed) {
    handle.end();
  } else {
    handle.end(new Error(`guardrail failed: ${reason ?? "no reason"}`));
  }
};

const handleGuardrailEvent: (payload: RunnerEventLike) => void = absorbErrorsSync(
  _handleGuardrailEvent,
  { fingerprint: "morse.openai-agents.guardrail.handle" },
) as (payload: RunnerEventLike) => void;

/* ------------------------------------------------------------------------ */
/*  Public installer                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Subscribe to the runner's `"guardrail_check"` events. Emit one
 * tool-shape span per check:
 *
 *   - wire `type = "tool"`
 *   - `metadata.tool_kind = "guardrail"`
 *   - `metadata.guardrail.passed: boolean`
 *   - `metadata.guardrail.name: string` (when present)
 *   - `metadata.guardrail.reason: string` (when present, typically on fail)
 *
 * On failure, the span closes with `failed` status. Returns an
 * unsubscribe function. No-op when `runner.on` is missing.
 */
export function installGuardrailInstrumentation(runner: RunnerLike): () => void {
  if (runner === null || typeof runner !== "object" || typeof runner.on !== "function") {
    return () => {
      /* no-op */
    };
  }

  const listener = (payload: RunnerEventLike): void => {
    handleGuardrailEvent(payload);
  };

  try {
    runner.on("guardrail_check", listener);
  } catch {
    return () => {
      /* no-op */
    };
  }

  return (): void => {
    try {
      if (typeof runner.off === "function") {
        runner.off("guardrail_check", listener);
      }
    } catch {
      /* swallow — telemetry must never throw at the caller */
    }
  };
}
