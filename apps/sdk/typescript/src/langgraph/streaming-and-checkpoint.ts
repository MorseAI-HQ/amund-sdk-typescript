/**
 * `langgraph/streaming-and-checkpoint.ts` — Phase 13 W2-L.3.
 *
 * Implements streaming-token aggregation for LangGraph JS. Per the design
 * doc, streaming tokens fire `handleLLMNewToken` at very high frequency —
 * we do NOT emit a span per token (would explode volume). Instead we
 * aggregate them onto the parent llm span's `metadata.tokens_streamed`
 * counter so downstream consumers can observe streaming activity without
 * the cardinality blowup.
 *
 * Checkpoint hooks (PostgresSaver / SqliteSaver / MemorySaver) are
 * deferred to v1.5 per the design doc. The surface is left empty here;
 * W3-L composes this module with the others and may add checkpoint
 * instrumentation in a follow-up wave without touching the wiring.
 *
 * All wrappers route through `absorbErrorsSync` — telemetry MUST NOT
 * throw at the caller.
 */

import { absorbErrorsSync } from "../_internal/errors";
import type { SpanHandle } from "../_internal/tracing";
import type { CallbackHandlerSurface } from "./types";

const ADAPTER_FINGERPRINT = "langgraph.streaming" as const;

/** State carried across streaming-token events for an in-flight chain run. */
export interface StreamingState {
  /** Map of `runId` → SpanHandle (the in-flight llm span W2-L.2 opened). */
  llmSpans: Map<string, SpanHandle>;
}

export interface StreamingHandlerOptions {
  /**
   * If true, emit a single `tokens_streamed` metadata count on the parent
   * llm span; default true. If false, the handler is a no-op (useful when
   * the host already tracks streaming elsewhere or wants to minimise
   * mutation under hot streaming loops).
   */
  trackStreamingTokens?: boolean;
}

/**
 * Returns the streaming-related callback method implementations.
 *
 * Currently exposes only `handleLLMNewToken`. Checkpoint methods
 * (`handleCheckpointStart` / `handleCheckpointEnd`) are not on the
 * `CallbackHandlerSurface` for v1 — they will land in v1.5 when we wire
 * the PostgresSaver/SqliteSaver hooks. Keeping this module in place
 * means W3-L's composition does not change shape when those land.
 */
export function createStreamingHandlers(
  state: StreamingState,
  options?: StreamingHandlerOptions,
): Pick<CallbackHandlerSurface, "handleLLMNewToken"> {
  const trackStreamingTokens = options?.trackStreamingTokens ?? true;

  const handleLLMNewToken = absorbErrorsSync(
    (_token: string, _idx: { prompt: number; completion: number }, runId: string): void => {
      if (!trackStreamingTokens) return;
      const handle = state.llmSpans.get(runId);
      if (handle === undefined) {
        // No matching llm span — happens when the host fires tokens
        // before `handleLLMStart` or after `handleLLMEnd`, or when the
        // runId is unknown (orphan event). Drop silently.
        return;
      }
      const md = (handle.span.metadata ?? {}) as Record<string, unknown>;
      const prev = typeof md.tokens_streamed === "number" ? md.tokens_streamed : 0;
      md.tokens_streamed = prev + 1;
      handle.span.metadata = md;
    },
    { fingerprint: ADAPTER_FINGERPRINT },
  );

  return { handleLLMNewToken };
}
