/**
 * `anthropic-agent-sdk/llm-instrumentation.ts` — taps `message_start` /
 * `message_stop` event pairs in a Claude Agent SDK stream and emits one
 * `llm` span per pair.
 *
 * The wrapper is a passthrough generator: every event is yielded to the
 * downstream caller unchanged. Span emission is a side-effect.
 *
 * One agent run can contain MULTIPLE llm calls (the agent loops on
 * tool-use → tool-result), so we emit one span PER message_start /
 * message_stop pair, not one for the whole stream.
 *
 * `context_segments` are extracted via `extractAnthropicSegments` from the
 * low-level Anthropic adapter (`../anthropic`) when the caller provides the
 * original request params. We DO NOT duplicate that logic here.
 *
 * Sibling W2-A files in this directory handle agent / tool / subagent /
 * hook spans separately.
 */

import { extractAnthropicSegments } from "../anthropic";
import { emitLlmSpan } from "../_agent-sdk-common/span-emitter";
import { calculateCost } from "../_internal/pricing";
import type { SpanHandle } from "../_internal/tracing";

import type {
  AnthropicMessageCreateParams,
  AnthropicMessageResponse,
  SDKMessageLike,
} from "./types";
import { report } from "../_internal/diagnostics";

/* ------------------------------------------------------------------------ */
/*  Public types                                                             */
/* ------------------------------------------------------------------------ */

export interface InstrumentLlmCallsOptions {
  /** Override the model name when the SDK doesn't report one on `message_start`. */
  fallbackModel?: string;
  /**
   * Original request params (the prompt + messages + tools the user passed
   * to `query()`). When provided, allows `extractAnthropicSegments` to
   * build `context_segments`. When omitted, `context_segments` is left
   * unset on the emitted span.
   */
  requestParams?: AnthropicMessageCreateParams;
}

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------ */

type UsageBlock = NonNullable<NonNullable<SDKMessageLike["message"]>["usage"]>;

/**
 * Read total input tokens from a `usage` block. We sum the regular
 * `input_tokens` with both cache-related counters because, per the
 * Anthropic Messages API, those represent input tokens that were either
 * written to or read from the prompt cache and are NOT included in
 * `input_tokens` itself.
 *
 * Returns `undefined` if NO input-related counter is present at all.
 */
function readInputTokens(usage: UsageBlock | undefined): number | undefined {
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  const base =
    typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : 0;
  const cacheWrite =
    typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0;
  if (
    usage.input_tokens === undefined &&
    usage.cache_creation_input_tokens === undefined &&
    usage.cache_read_input_tokens === undefined
  ) {
    return undefined;
  }
  return base + cacheWrite + cacheRead;
}

function readOutputTokens(usage: UsageBlock | undefined): number | undefined {
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  if (typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)) {
    return usage.output_tokens;
  }
  return undefined;
}

function readCacheWriteTokens(usage: UsageBlock | undefined): number | undefined {
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  if (
    typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens) &&
    usage.cache_creation_input_tokens > 0
  ) {
    return usage.cache_creation_input_tokens;
  }
  return undefined;
}

function readCachedInputTokens(usage: UsageBlock | undefined): number | undefined {
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  if (
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens) &&
    usage.cache_read_input_tokens > 0
  ) {
    return usage.cache_read_input_tokens;
  }
  return undefined;
}

/**
 * Compute and set `handle.span.cost_usd` from the pricing table when the
 * model + token counts are known and no cost has already been set.
 * Mirrors the Python adapter's `calculate_cost(...)` call after usage
 * extraction.
 */
function applyCost(
  handle: SpanHandle,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheWriteTokens: number | undefined,
  cachedInputTokens: number | undefined,
): void {
  if (handle.span.cost_usd !== undefined) return;
  if (inputTokens === undefined && outputTokens === undefined) return;
  const cost = calculateCost({
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    model,
    cachedInputTokens: cachedInputTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
  });
  if (cost !== undefined) handle.span.cost_usd = cost;
}

/**
 * Safely run a function; swallow any thrown errors. Telemetry must NEVER
 * surface failures to the caller's iteration.
 */
function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // intentionally swallowed
    reportSwallowed(err, "morse.anthropic_agent_sdk.llm_instrumentation");
  }
}

/* ------------------------------------------------------------------------ */
/*  instrumentLlmCalls                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Wrap an async iterable of `SDKMessageLike` events: pass each event through
 * unchanged, but tap `message_start` / `message_stop` pairs and emit one
 * `llm` span per pair.
 *
 * Behaviour:
 *
 *   - The span opens at `message_start` (model is read from `event.message.model`
 *     or falls back to `options.fallbackModel`).
 *   - Token usage is read from `event.message.usage` on `message_stop` —
 *     the start-event usage is only partial. `input_tokens` sums
 *     `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 *   - If `requestParams` is provided, `context_segments` is populated via
 *     `extractAnthropicSegments(requestParams, response)`.
 *   - Orphan `message_stop` events (with no preceding start) are tolerated:
 *     no span, no error.
 *   - If the iterator ends with an open span (a start without a matching
 *     stop), the span is closed as failed.
 *   - All telemetry is wrapped in try/catch — it MUST NOT break iteration.
 */
export async function* instrumentLlmCalls(
  events: AsyncIterable<SDKMessageLike>,
  options?: InstrumentLlmCallsOptions,
): AsyncIterable<SDKMessageLike> {
  let openSpan: SpanHandle | null = null;
  const fallbackModel = options?.fallbackModel;
  const requestParams = options?.requestParams;

  try {
    for await (const event of events) {
      const eventType = typeof event?.type === "string" ? event.type : "";

      // Real Claude Agent SDK shape: type=`assistant` events carry the full
      // assistant message (one per assistant turn). Each maps to one `llm`
      // span. Mock-shape `message_start`/`message_stop` is still handled
      // below for the unit-test fixtures.
      if (eventType === "assistant" && event.message) {
        safe(() => {
          // Close any prior open span — should be rare; assistant events
          // are non-overlapping turns.
          if (openSpan !== null) {
            openSpan.end();
            openSpan = null;
          }
          const reportedModel =
            typeof event.message?.model === "string" && event.message.model.length > 0
              ? event.message.model
              : undefined;
          const model = reportedModel ?? fallbackModel;
          if (!model) return;
          const handle = emitLlmSpan({ adapter: "anthropic-agent-sdk", model });
          if (!handle) return;
          const usage = event.message?.usage;
          const inputTokens = readInputTokens(usage);
          const outputTokens = readOutputTokens(usage);
          const cacheWriteTokens = readCacheWriteTokens(usage);
          const cachedInputTokens = readCachedInputTokens(usage);
          if (inputTokens !== undefined) handle.span.input_tokens = inputTokens;
          if (outputTokens !== undefined) handle.span.output_tokens = outputTokens;
          if (cacheWriteTokens !== undefined) handle.span.cache_write_tokens = cacheWriteTokens;
          if (cachedInputTokens !== undefined) handle.span.cached_input_tokens = cachedInputTokens;
          if (inputTokens !== undefined && outputTokens !== undefined) {
            handle.span.total_tokens = inputTokens + outputTokens;
          }
          applyCost(handle, model, inputTokens, outputTokens, cacheWriteTokens, cachedInputTokens);
          if (requestParams !== undefined) {
            try {
              const segments = extractAnthropicSegments(
                requestParams,
                event.message as AnthropicMessageResponse | undefined,
              );
              if (Array.isArray(segments) && segments.length > 0) {
                handle.span.context_segments = segments;
              }
            } catch {
              // segment extraction failed; leave context_segments unset
            }
          }
          handle.end();
        });
      } else if (eventType === "message_start") {
        // Open a new span. If there's already an open span (start without
        // stop), close the previous one as failed before opening the new one.
        safe(() => {
          if (openSpan !== null) {
            openSpan.end(new Error("morse: message_start without preceding message_stop"));
            openSpan = null;
          }
          const reportedModel =
            typeof event.message?.model === "string" && event.message.model.length > 0
              ? event.message.model
              : undefined;
          const model = reportedModel ?? fallbackModel;
          if (model === undefined || model.length === 0) {
            // emitLlmSpan requires a model; skip silently.
            return;
          }
          openSpan = emitLlmSpan({
            adapter: "anthropic-agent-sdk",
            model,
          });
        });
      } else if (eventType === "message_stop") {
        if (openSpan !== null) {
          const handle: SpanHandle = openSpan;
          openSpan = null;
          safe(() => {
            const usage = event.message?.usage;
            const inputTokens = readInputTokens(usage);
            const outputTokens = readOutputTokens(usage);
            const cacheWriteTokens = readCacheWriteTokens(usage);
            const cachedInputTokens = readCachedInputTokens(usage);
            if (inputTokens !== undefined) {
              handle.span.input_tokens = inputTokens;
            }
            if (outputTokens !== undefined) {
              handle.span.output_tokens = outputTokens;
            }
            if (cacheWriteTokens !== undefined) {
              handle.span.cache_write_tokens = cacheWriteTokens;
            }
            if (cachedInputTokens !== undefined) {
              handle.span.cached_input_tokens = cachedInputTokens;
            }
            if (inputTokens !== undefined && outputTokens !== undefined) {
              handle.span.total_tokens = inputTokens + outputTokens;
            }
            if (handle.span.model) {
              applyCost(
                handle,
                handle.span.model,
                inputTokens,
                outputTokens,
                cacheWriteTokens,
                cachedInputTokens,
              );
            }
            if (requestParams !== undefined) {
              try {
                const segments = extractAnthropicSegments(
                  requestParams,
                  event.message as AnthropicMessageResponse | undefined,
                );
                if (Array.isArray(segments) && segments.length > 0) {
                  handle.span.context_segments = segments;
                }
              } catch {
                // segment extraction failed; leave context_segments unset
              }
            }
            handle.end();
          });
        }
        // Orphan message_stop: ignore silently.
      }

      yield event;
    }
  } finally {
    // If iteration ended mid-message (start without stop), close the span as failed.
    if (openSpan !== null) {
      const handle: SpanHandle = openSpan;
      openSpan = null;
      safe(() => {
        handle.end(new Error("morse: iterator ended before message_stop"));
      });
    }
  }
}

/**
 * Route a swallowed internal error to the diagnostics channel (SDKDIAG-07).
 *
 * Control flow is unchanged — the site still swallows, still returns the same
 * value. It is simply no longer invisible to us.
 */
function reportSwallowed(err: unknown, fingerprint: string): void {
  try {
    report(err, { fingerprint });
  } catch {
    // Reporting must never break the swallow it is reporting on.
  }
}
