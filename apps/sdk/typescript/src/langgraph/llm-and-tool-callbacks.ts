/**
 * `langgraph/llm-and-tool-callbacks.ts` — W2-L.2.
 *
 * LangGraph JS callback handler fragment that owns the llm + tool surface
 * of `BaseCallbackHandler`. The class shell (constructor + chain methods)
 * is owned by W2-L.1 (`callback-handler.ts`); streaming + checkpoint by
 * W2-L.3 (`streaming-and-checkpoint.ts`). All three are composed together
 * by W3-L (`langgraph/index.ts`).
 *
 * To stay file-disjoint across the three W2-L tasks, each fragment exports
 * a `createX` factory that returns plain method implementations operating
 * on a shared mutable `LangGraphRunState`. The host class threads its
 * `state` reference through each factory in its constructor and copies the
 * methods onto its prototype/instance.
 *
 * Logical span mapping (per design.md §LangGraph JS):
 *   handleLLMStart       / handleChatModelStart  → open `type=llm` span
 *   handleLLMEnd         / handleLLMError        → close active llm span
 *   handleToolStart                              → open `type=tool` span
 *   handleToolEnd        / handleToolError       → close active tool span
 *
 * MHQ-750: `handleChatModelStart` also decomposes the flattened messages
 * (+ any bound `tools`) into `context_segments` via the shared
 * `_agent-sdk-common/context-decomposer`, mirroring the Python adapter's
 * `on_chat_model_start` (`adapters/langgraph.py`), which calls the same
 * `decompose_openai_messages` for the same reason: LangGraph JS messages
 * are `@langchain/core` `BaseMessage`s, which decompose cleanly under the
 * OpenAI-chat-format decomposer's `_getType()`/`.type` duck-typing.
 *
 * All bodies are wrapped in `absorbErrorsSync` so telemetry can never
 * throw at the host LangGraph runtime.
 */

import { absorbErrorsSync } from "../_internal/errors";
import { calculateCost } from "../_internal/pricing";
import type { SpanHandle } from "../_internal/tracing";
import { emitLlmSpan, emitToolSpan } from "../_agent-sdk-common/span-emitter";
import { setActiveFramework } from "../_internal/active-framework";
import {
  captureLangChainMessages,
  capturePrompts,
  extractLangChainOutputText,
} from "../_internal/llm-io";
import { summarizeToolInput, summarizeToolOutput } from "../_agent-sdk-common/redaction";
import { decomposeOpenAiMessages } from "../_agent-sdk-common/context-decomposer";
import type {
  BaseMessageLike,
  CallbackHandlerSurface,
  LLMResultLike,
  SerializedLike,
} from "./types";

const ADAPTER = "langgraph-js" as const;
// MHQ-859: the framework label is cross-language and must match Python's
// `langgraph.py::_framework_name` exactly — it is what the server groups on,
// so "langgraph-js" here would split one framework into two.
const FRAMEWORK = "langgraph" as const;

/* ------------------------------------------------------------------------ */
/*  Shared run state                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Shared per-instance state for the composed `MorseCallbackHandler`.
 * Owned/instantiated by W3-L (`langgraph/index.ts`); each W2-L fragment
 * mutates it in place.
 */
export interface LangGraphRunState {
  /** Map of runId → SpanHandle for open llm spans. */
  llmSpans: Map<string, SpanHandle>;
  /** Map of runId → SpanHandle for open tool spans. */
  toolSpans: Map<string, SpanHandle>;
  /** Map of runId → SpanHandle for open chain spans (populated by W2-L.1). */
  chainSpans: Map<string, SpanHandle>;
}

export interface LlmAndToolHandlerOptions {
  /** Max bytes for tool input summary. Falls through to module default if unset. */
  toolInputMaxBytes?: number;
  /** Max bytes for tool output summary. Falls through to module default if unset. */
  toolOutputMaxBytes?: number;
}

/** Convenient public type alias for the slice of methods this file owns. */
export type LlmAndToolHandlers = Pick<
  CallbackHandlerSurface,
  | "handleLLMStart"
  | "handleChatModelStart"
  | "handleLLMEnd"
  | "handleLLMError"
  | "handleToolStart"
  | "handleToolEnd"
  | "handleToolError"
>;

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Extract a provider hint from the `id` path produced by LangChain's
 * `Serializable` machinery. The first segment is usually the package name
 * (`langchain_openai`, `langchain_anthropic`, `langchain_google_vertexai`,
 * etc.). We strip the `langchain_` prefix when present and return the
 * remainder; otherwise we return the first segment verbatim. Returns
 * `undefined` when no identifying segment is available.
 */
function extractProvider(id: string[] | undefined): string | undefined {
  if (!Array.isArray(id) || id.length === 0) return undefined;
  const first = id[0];
  if (typeof first !== "string" || first.length === 0) return undefined;
  if (first.startsWith("langchain_")) {
    const tail = first.slice("langchain_".length);
    return tail.length > 0 ? tail : undefined;
  }
  return first;
}

/**
 * MHQ-788: `llm.name` is LangChain's `Serializable` class name (e.g.
 * `"ChatOpenAI"`), never the actual model string — it was always the wrong
 * field, and empty in practice for the real `@langchain/openai` callback
 * invocation this bug was found against. The real model lives in
 * `extraParams.invocation_params.model` (see `chat_models.cjs`'s
 * `invocationParams()` — every provider's chat model puts its model field
 * there before calling `handleChatModelStart`/`handleLLMStart`).
 * `llm.name` is kept only as a last-resort fallback for providers that
 * don't populate `invocation_params.model` for some reason.
 */
function llmModelOf(
  llm: SerializedLike | undefined,
  extraParams?: Record<string, unknown>,
): string {
  const invocationParams = extraParams?.invocation_params;
  if (invocationParams && typeof invocationParams === "object") {
    const model =
      (invocationParams as { model?: unknown; model_name?: unknown }).model ??
      (invocationParams as { model?: unknown; model_name?: unknown }).model_name;
    if (typeof model === "string" && model.length > 0) return model;
  }
  if (llm !== undefined && typeof llm.name === "string" && llm.name.length > 0) {
    return llm.name;
  }
  return "unknown";
}

function toolNameOf(tool: SerializedLike | undefined): string {
  if (tool !== undefined && typeof tool.name === "string" && tool.name.length > 0) {
    return tool.name;
  }
  return "unknown";
}

/**
 * LangChain JS passes `handleChatModelStart` a nested `BaseMessage[][]` —
 * one array per "prompt" in a batch call. The decomposer expects a flat
 * list of message objects, so flatten one level (mirrors Python's
 * `_flatten_messages` in `adapters/langgraph.py`).
 */
function flattenMessages(messages: BaseMessageLike[][] | undefined): BaseMessageLike[] {
  if (!Array.isArray(messages)) return [];
  const flat: BaseMessageLike[] = [];
  for (const item of messages) {
    if (Array.isArray(item)) {
      flat.push(...item);
    } else if (item !== undefined && item !== null) {
      flat.push(item as unknown as BaseMessageLike);
    }
  }
  return flat;
}

/** Extract the bound `tools` array from `handleChatModelStart`'s `extra.invocation_params`. */
function toolsFromExtra(extra: Record<string, unknown> | undefined): unknown {
  const invocationParams = extra?.invocation_params as Record<string, unknown> | undefined;
  return invocationParams?.tools;
}

function applyTokenUsage(handle: SpanHandle, output: LLMResultLike | undefined): void {
  const usage = output?.llmOutput?.tokenUsage;
  if (!usage || typeof usage !== "object") return;
  const prompt = (usage as Record<string, unknown>).promptTokens;
  const completion = (usage as Record<string, unknown>).completionTokens;
  const total = (usage as Record<string, unknown>).totalTokens;
  if (typeof prompt === "number" && Number.isFinite(prompt)) {
    handle.span.input_tokens = prompt;
  }
  if (typeof completion === "number" && Number.isFinite(completion)) {
    handle.span.output_tokens = completion;
  }
  if (typeof total === "number" && Number.isFinite(total)) {
    handle.span.total_tokens = total;
  } else if (
    typeof handle.span.input_tokens === "number" &&
    typeof handle.span.output_tokens === "number"
  ) {
    handle.span.total_tokens = handle.span.input_tokens + handle.span.output_tokens;
  }
  if (
    handle.span.cost_usd === undefined &&
    handle.span.model &&
    (typeof handle.span.input_tokens === "number" || typeof handle.span.output_tokens === "number")
  ) {
    const cost = calculateCost({
      inputTokens: handle.span.input_tokens ?? 0,
      outputTokens: handle.span.output_tokens ?? 0,
      model: handle.span.model,
    });
    if (cost !== undefined) handle.span.cost_usd = cost;
  }
}

function popAndEnd(
  map: Map<string, SpanHandle>,
  runId: string,
  err?: unknown,
  mutate?: (handle: SpanHandle) => void,
): void {
  const handle = map.get(runId);
  if (handle === undefined) return;
  map.delete(runId);
  if (mutate !== undefined) {
    mutate(handle);
  }
  if (err !== undefined) {
    handle.end(err);
  } else {
    handle.end();
  }
}

/* ------------------------------------------------------------------------ */
/*  Factory                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Build the llm + tool slice of an `MorseCallbackHandler`. The
 * returned object can be merged onto the host class instance (W3-L); each
 * method mutates `state` in place so all three fragments share the same
 * `runId → SpanHandle` maps.
 *
 * Every method body is wrapped in `absorbErrorsSync` — telemetry never
 * throws into the LangGraph runtime.
 */
export function createLlmAndToolHandlers(
  state: LangGraphRunState,
  options: LlmAndToolHandlerOptions = {},
): LlmAndToolHandlers {
  const toolInputOpts = options.toolInputMaxBytes
    ? { maxBytes: options.toolInputMaxBytes }
    : undefined;
  const toolOutputOpts = options.toolOutputMaxBytes
    ? { maxBytes: options.toolOutputMaxBytes }
    : undefined;

  const _handleLLMStart = (
    llm: SerializedLike,
    prompts: string[],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void => {
    setActiveFramework(FRAMEWORK);
    const handle = emitLlmSpan({
      adapter: ADAPTER,
      model: llmModelOf(llm, extraParams),
      provider: extractProvider(llm?.id),
      inputData: capturePrompts(prompts),
    });
    if (handle !== null) {
      state.llmSpans.set(runId, handle);
    }
  };

  const _handleChatModelStart = (
    llm: SerializedLike,
    messages: BaseMessageLike[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void => {
    // Chat models ARE LLMs — emit a `type=llm` span, same as handleLLMStart.
    // MHQ-750: also decompose the flattened messages (+ bound tools, if
    // any) into context_segments so the dashboard shows context
    // composition for LangGraph JS spans without extra customer config.
    const flatMessages = flattenMessages(messages);
    const contextSegments = decomposeOpenAiMessages(flatMessages, toolsFromExtra(extraParams));
    setActiveFramework(FRAMEWORK);
    const handle = emitLlmSpan({
      adapter: ADAPTER,
      model: llmModelOf(llm, extraParams),
      provider: extractProvider(llm?.id),
      contextSegments: contextSegments.length > 0 ? contextSegments : undefined,
      inputData: captureLangChainMessages(flatMessages),
    });
    if (handle !== null) {
      state.llmSpans.set(runId, handle);
    }
  };

  const _handleLLMEnd = (output: LLMResultLike, runId: string): void => {
    popAndEnd(state.llmSpans, runId, undefined, (handle) => {
      applyTokenUsage(handle, output);
      // MHQ-858: the response text is only available at end-of-call, so
      // output_data is set here rather than on the emitLlmSpan above.
      const outputText = extractLangChainOutputText(output?.generations);
      if (outputText !== undefined) handle.span.output_data = { content: outputText };
    });
  };

  const _handleLLMError = (err: unknown, runId: string): void => {
    popAndEnd(state.llmSpans, runId, err);
  };

  const _handleToolStart = (tool: SerializedLike, input: string, runId: string): void => {
    const handle = emitToolSpan({
      adapter: ADAPTER,
      toolName: toolNameOf(tool),
      inputSummary: summarizeToolInput(input, toolInputOpts),
    });
    if (handle !== null) {
      state.toolSpans.set(runId, handle);
    }
  };

  const _handleToolEnd = (output: string, runId: string): void => {
    popAndEnd(state.toolSpans, runId, undefined, (handle) => {
      const md = (handle.span.metadata ??= {} as Record<string, unknown>);
      md.tool_output_summary = summarizeToolOutput(output, toolOutputOpts);
      md.success = true;
    });
  };

  const _handleToolError = (err: unknown, runId: string): void => {
    popAndEnd(state.toolSpans, runId, err, (handle) => {
      const md = (handle.span.metadata ??= {} as Record<string, unknown>);
      md.success = false;
    });
  };

  const fp = "morse.adapters.langgraph.llm-and-tool";

  return {
    handleLLMStart: absorbErrorsSync(_handleLLMStart, { fingerprint: `${fp}.handleLLMStart` }),
    handleChatModelStart: absorbErrorsSync(_handleChatModelStart, {
      fingerprint: `${fp}.handleChatModelStart`,
    }),
    handleLLMEnd: absorbErrorsSync(_handleLLMEnd, { fingerprint: `${fp}.handleLLMEnd` }),
    handleLLMError: absorbErrorsSync(_handleLLMError, { fingerprint: `${fp}.handleLLMError` }),
    handleToolStart: absorbErrorsSync(_handleToolStart, { fingerprint: `${fp}.handleToolStart` }),
    handleToolEnd: absorbErrorsSync(_handleToolEnd, { fingerprint: `${fp}.handleToolEnd` }),
    handleToolError: absorbErrorsSync(_handleToolError, { fingerprint: `${fp}.handleToolError` }),
  };
}
