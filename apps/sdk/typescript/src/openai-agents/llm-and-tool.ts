/**
 * `openai-agents/llm-and-tool.ts` — Phase 13 W2-O.2.
 *
 * Subscribes to the OpenAI Agents `Runner`'s event channel and emits `llm`
 * and `tool` spans for each `*_call_start` / `*_call_end` pair.
 *
 * The real `@openai/agents` Runner fires events on both typed channels
 * (e.g. `runner.on("llm_call_start", ...)`) and a catch-all `"event"`
 * channel. We register on the typed channels only — the FakeRunner used
 * in tests mirrors that behaviour, and using typed-only avoids the
 * double-emit risk if a host has wired both.
 *
 * Call matching is FIFO via two per-installation stacks (one for llm,
 * one for tool). Within a single `Runner.run` the SDK does not interleave
 * calls, so FIFO is sufficient — and it tolerates orphan `_end` events
 * (no matching `_start`) by simply ignoring them.
 *
 * All span emission goes through the shared `_agent-sdk-common/span-emitter`
 * helpers which are themselves wrapped in `absorbErrorsSync` — telemetry
 * MUST NOT throw at the caller.
 *
 * MHQ-750: when the `llm_call_start` event carries `event.llm.messages`
 * (OpenAI-chat-completions-shaped, since `@openai/agents` is built on the
 * same request format), they're decomposed into `context_segments` via the
 * shared `_agent-sdk-common/context-decomposer` — the same decomposer used
 * by `../langgraph/` and `../langchain/`. `event.llm.messages` is optional
 * on the structural `RunnerEventLike` type; hosts that don't surface it
 * simply produce no `context_segments`, same as before this change.
 */

import { absorbErrorsSync } from "../_internal/errors";
import { calculateCost } from "../_internal/pricing";
import type { SpanHandle } from "../_internal/tracing";
import { emitLlmSpan, emitToolSpan } from "../_agent-sdk-common/span-emitter";
import { summarizeToolInput, summarizeToolOutput } from "../_agent-sdk-common/redaction";
import { decomposeOpenAiMessages } from "../_agent-sdk-common/context-decomposer";
import type { RunnerEventLike, RunnerLike } from "./types";

const ADAPTER = "openai-agents" as const;

export interface InstallLlmAndToolInstrumentationOptions {
  /** Max bytes for serialized tool input summary. Defaults to redaction helper's cap. */
  toolInputMaxBytes?: number;
  /** Max bytes for serialized tool output summary. Defaults to redaction helper's cap. */
  toolOutputMaxBytes?: number;
}

/**
 * Subscribe to the runner's event channel and emit `llm` and `tool` spans
 * for each `_call_start`/`_call_end` pair.
 *
 * Returns an unsubscribe function. If `runner.on` is not a function (e.g.
 * the host injected a mock), returns a no-op unsubscriber.
 */
export function installLlmAndToolInstrumentation(
  runner: RunnerLike,
  options?: InstallLlmAndToolInstrumentationOptions,
): () => void {
  if (typeof runner?.on !== "function") {
    return () => {
      /* no-op */
    };
  }

  const opts = options ?? {};
  const llmStack: SpanHandle[] = [];
  const toolStack: SpanHandle[] = [];

  const onLlmStart = absorbErrorsSync(
    (event: RunnerEventLike): void => {
      const contextSegments = decomposeOpenAiMessages(event.llm?.messages, event.llm?.tools);
      const handle = emitLlmSpan({
        adapter: ADAPTER,
        model:
          typeof event.llm?.model === "string" && event.llm.model.length > 0
            ? event.llm.model
            : "unknown",
        provider: typeof event.llm?.provider === "string" ? event.llm.provider : undefined,
        contextSegments: contextSegments.length > 0 ? contextSegments : undefined,
      });
      if (handle !== null) llmStack.push(handle);
    },
    { fingerprint: "morse.openai-agents.llm_call_start" },
  );

  const onLlmEnd = absorbErrorsSync(
    (event: RunnerEventLike): void => {
      const handle = llmStack.shift();
      if (handle === undefined) return; // orphan _end, tolerate
      const usage = event.llm?.usage;
      if (usage !== undefined && usage !== null) {
        if (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)) {
          handle.span.input_tokens = usage.input_tokens;
        }
        if (typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)) {
          handle.span.output_tokens = usage.output_tokens;
        }
        if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) {
          handle.span.total_tokens = usage.total_tokens;
        } else if (
          handle.span.input_tokens !== undefined &&
          handle.span.output_tokens !== undefined
        ) {
          handle.span.total_tokens = handle.span.input_tokens + handle.span.output_tokens;
        }
        const cachedTokens =
          typeof usage.cached_tokens === "number" && Number.isFinite(usage.cached_tokens)
            ? usage.cached_tokens
            : 0;
        if (
          handle.span.cost_usd === undefined &&
          handle.span.model &&
          (handle.span.input_tokens !== undefined || handle.span.output_tokens !== undefined)
        ) {
          const cost = calculateCost({
            inputTokens: handle.span.input_tokens ?? 0,
            outputTokens: handle.span.output_tokens ?? 0,
            model: handle.span.model,
            cachedInputTokens: cachedTokens,
          });
          if (cost !== undefined) handle.span.cost_usd = cost;
        }
      }
      handle.end();
    },
    { fingerprint: "morse.openai-agents.llm_call_end" },
  );

  const onToolStart = absorbErrorsSync(
    (event: RunnerEventLike): void => {
      const toolName =
        typeof event.tool?.name === "string" && event.tool.name.length > 0
          ? event.tool.name
          : "unknown";
      const inputSummary = summarizeToolInput(
        event.tool?.input,
        opts.toolInputMaxBytes !== undefined ? { maxBytes: opts.toolInputMaxBytes } : undefined,
      );
      const handle = emitToolSpan({
        adapter: ADAPTER,
        toolName,
        inputSummary,
      });
      if (handle !== null) toolStack.push(handle);
    },
    { fingerprint: "morse.openai-agents.tool_call_start" },
  );

  const onToolEnd = absorbErrorsSync(
    (event: RunnerEventLike): void => {
      const handle = toolStack.shift();
      if (handle === undefined) return; // orphan _end, tolerate
      const outputSummary = summarizeToolOutput(
        event.tool?.output,
        opts.toolOutputMaxBytes !== undefined ? { maxBytes: opts.toolOutputMaxBytes } : undefined,
      );
      const success = typeof event.tool?.success === "boolean" ? event.tool.success : true;
      const metadata = (handle.span.metadata ?? {}) as Record<string, unknown>;
      const tool =
        metadata.tool !== undefined && metadata.tool !== null
          ? (metadata.tool as Record<string, unknown>)
          : {};
      tool.output_summary = outputSummary;
      tool.success = success;
      if (typeof event.tool?.duration_ms === "number" && Number.isFinite(event.tool.duration_ms)) {
        tool.duration_ms = event.tool.duration_ms;
      }
      metadata.tool = tool;
      metadata.tool_output_summary = outputSummary;
      handle.span.metadata = metadata;
      if (success === false) {
        handle.end(new Error("tool call reported failure"));
      } else {
        handle.end();
      }
    },
    { fingerprint: "morse.openai-agents.tool_call_end" },
  );

  // Register on typed channels.
  runner.on("llm_call_start", onLlmStart);
  runner.on("llm_call_end", onLlmEnd);
  runner.on("tool_call_start", onToolStart);
  runner.on("tool_call_end", onToolEnd);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    if (typeof runner.off === "function") {
      runner.off("llm_call_start", onLlmStart);
      runner.off("llm_call_end", onLlmEnd);
      runner.off("tool_call_start", onToolStart);
      runner.off("tool_call_end", onToolEnd);
    }
  };
}
