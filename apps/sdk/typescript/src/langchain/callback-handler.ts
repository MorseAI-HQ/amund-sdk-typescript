/**
 * `@morsehq-dev/sdk/langchain` — `MorseCallbackHandler` for plain LangChain
 * (chains, LLMs, tools, retrievers). Port of
 * `apps/sdk/python/src/morse_ai/adapters/langchain.py` (MHQ-482).
 *
 * Usage:
 *
 * ```ts
 * import { MorseCallbackHandler } from "@morsehq-dev/sdk/langchain";
 * import { runAsync } from "@morsehq-dev/sdk"; // or morse.run()
 *
 * const handler = new MorseCallbackHandler({ agentName: "my-agent" });
 * await runAsync({ agentName: "my-agent" }, async () => {
 *   await chain.invoke(input, { callbacks: [handler] });
 * });
 * ```
 *
 * Span mapping (mirrors the Python adapter):
 *   - handleChainStart / handleChainEnd / handleChainError → `type=agent`
 *   - handleLLMStart / handleChatModelStart / handleLLMEnd / handleLLMError → `type=llm`
 *   - handleToolStart / handleToolEnd / handleToolError → `type=tool`
 *   - handleRetrieverStart / handleRetrieverEnd / handleRetrieverError (@beta)
 *     → `type=retriever`
 *
 * ## Deviations from the Python adapter (see PR report for full rationale)
 *
 * 1. **No auto-trace creation.** Python's `MorseCallbackHandler` calls
 *    `morse_ai.tracing.run(...)` itself when no trace is active (contextvars
 *    support manually entering/exiting a context across independent callback
 *    invocations). The TS SDK's trace context is `AsyncLocalStorage`-based
 *    (`_internal/tracing.ts`), which only supports the `als.run(store, fn)`
 *    callback shape — there is no way to open a trace and leave it open
 *    across separate, unwrapped callback calls. Callers MUST wrap the
 *    LangChain invocation in `morse.run()` / `runAsync()`. This mirrors the
 *    constraint the existing `../langgraph/` adapter already operates under
 *    (see its file-header comments) — every span helper silently no-ops
 *    (returns `null`) when there is no active trace, exactly like this file.
 * 2. **No structural subclass relationship with `../langgraph/`.** The task
 *    brief notes that Python's `langgraph.py::LangGraphCallbackHandler`
 *    subclasses `langchain.py::MorseCallbackHandler`. `@langchain/core`'s
 *    `BaseCallbackHandler` surface is identical for plain chains and for
 *    LangGraph graphs (LangGraph JS is built on `@langchain/core`
 *    callbacks), so structurally the two TS adapters COULD share a base.
 *    But the existing `../langgraph/` files are off-limits for this task
 *    (a separate, already-shipped gap) and refactoring them to extract a
 *    shared base is out of scope / higher risk than the value it buys right
 *    now. This adapter is therefore a structural sibling, not a subclass —
 *    same conventions (span-emission via `startSpan`, `absorbErrorsSync`
 *    everywhere, `metadata.adapter` tagging), independently implemented.
 * 3. **No cost computation.** Python's `on_llm_end` calls
 *    `morse_ai.pricing.calculate_cost` and `merge_provider_reported_cost`.
 *    Neither has a TS port yet (owned by a separate parallel MHQ-482 gap).
 *    Token counts/model are still captured; `cost_usd` is left unset until
 *    the pricing gap lands.
 * 4. **`type=retriever` uses a real, added `SpanType` variant** (see
 *    `_internal/spans.ts`) rather than the `type=tool` +
 *    `metadata.tool_kind` fallback pattern used for `hook`/`subagent` — the
 *    backend already accepts `"retriever"` (Python's `SpanType.RETRIEVER`
 *    has shipped since the Python adapter), so no fallback is needed.
 *
 * All public methods absorb internal errors (never throw into the LangChain
 * runtime) — mirrors Python's `try/except Exception: logger.debug(...)`
 * wrapping on every callback.
 */

import { absorbErrorsSync } from "../_internal/errors";
import type { SpanHandle } from "../_internal/tracing";
import { adoptThreadId, startSpan } from "../_internal/tracing";
import { decomposeOpenAiMessages } from "../_agent-sdk-common/context-decomposer";
import { captureLangChainMessages } from "../_internal/llm-io";
import type {
  BaseMessageLike,
  CallbackHandlerSurface,
  DocumentLike,
  LangChainCoreCallbacksModuleLike,
  LLMResultLike,
  SerializedLike,
} from "./types";

/* ------------------------------------------------------------------------ */
/*  Constants                                                                */
/* ------------------------------------------------------------------------ */

const ADAPTER = "langchain-js" as const;
const HANDLER_NAME = "morse_callback_handler";
const DEFAULT_AGENT_NAME = "langchain-agent";

// AGE-260 port: cap on the JSON-serialized size of any single input_data /
// output_data payload. Mirrors the Python adapter's `_MAX_STATE_PAYLOAD_BYTES`.
const MAX_STATE_PAYLOAD_BYTES = 64 * 1024; // 64 KB JSON

/* ------------------------------------------------------------------------ */
/*  Public options                                                          */
/* ------------------------------------------------------------------------ */

export interface MorseCallbackHandlerOptions {
  /** Falls back to `"langchain-agent"` when unset. Only used for documentation
   * purposes on this handler instance — the actual trace's agent name is set
   * by whatever `morse.run()` / `runAsync()` call wraps the invocation. */
  agentName?: string;
}

/* ------------------------------------------------------------------------ */
/*  Name resolution helpers                                                 */
/* ------------------------------------------------------------------------ */

/** chain/llm: prefer `id` path tail, then `name`, then `fallback`. */
function resolveNameIdFirst(
  serialized: SerializedLike | null | undefined,
  fallback: string,
): string {
  const s = serialized ?? {};
  const idPath = s.id;
  if (Array.isArray(idPath) && idPath.length > 0) {
    const last = idPath[idPath.length - 1];
    if (typeof last === "string" && last.length > 0) return last;
  }
  if (typeof s.name === "string" && s.name.length > 0) return s.name;
  return fallback;
}

/** tool: prefer `name`, then `id` path tail, then `fallback`. */
function resolveNameNameFirst(
  serialized: SerializedLike | null | undefined,
  fallback: string,
): string {
  const s = serialized ?? {};
  if (typeof s.name === "string" && s.name.length > 0) return s.name;
  const idPath = s.id;
  if (Array.isArray(idPath) && idPath.length > 0) {
    const last = idPath[idPath.length - 1];
    if (typeof last === "string" && last.length > 0) return last;
  }
  return fallback;
}

/* ------------------------------------------------------------------------ */
/*  State coercion — port of Python's `_ensure_dict`                        */
/* ------------------------------------------------------------------------ */

function utf8ByteLength(s: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  // Rough fallback — good enough for a soft cap, never load-bearing for
  // correctness (only used to decide whether to truncate).
  return s.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Coerce arbitrary LangChain chain/tool/retriever input or output into a
 * dict payload the wire schema requires (`SpanData.input_data` /
 * `output_data`). Port of Python's `MorseCallbackHandler._ensure_dict`:
 *
 * - `null` / `undefined`           → `undefined` (legitimately absent)
 * - plain object                   → unchanged
 * - object with a callable `toJSON()` returning a plain object → that result
 *   (JS analogue of Python's Pydantic `model_dump()` / `dict()` duck typing)
 * - other (string / number / array / class instance) → `{ value: String(x) }`
 *
 * Oversized payloads (JSON > `MAX_STATE_PAYLOAD_BYTES`) are replaced with a
 * truncation marker so the transport queue stays bounded but the dashboard
 * still shows a usable preview — never silently dropped to `undefined`.
 */
export function coerceStateValue(data: unknown): Record<string, unknown> | undefined {
  if (data === null || data === undefined) return undefined;

  let coerced: Record<string, unknown>;
  if (isPlainObject(data)) {
    coerced = data;
  } else {
    const toJSON = (data as { toJSON?: unknown }).toJSON;
    let viaToJSON: Record<string, unknown> | null = null;
    if (typeof toJSON === "function") {
      try {
        const result: unknown = (toJSON as () => unknown).call(data);
        if (isPlainObject(result)) viaToJSON = result;
      } catch {
        viaToJSON = null;
      }
    }
    if (viaToJSON !== null) {
      coerced = viaToJSON;
    } else if (Array.isArray(data)) {
      coerced = { value: safeStringify(data) };
    } else {
      coerced = { value: String(data) };
    }
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(coerced) ?? "null";
  } catch {
    return {
      _truncated: true,
      _reason: "unserializable",
      value: String(coerced).slice(0, 1024),
    };
  }

  const byteLen = utf8ByteLength(encoded);
  if (byteLen > MAX_STATE_PAYLOAD_BYTES) {
    const preview = encoded.slice(0, Math.floor(MAX_STATE_PAYLOAD_BYTES / 2));
    return {
      _truncated: true,
      _reason: "payload_too_large",
      _original_size_bytes: byteLen,
      _max_bytes: MAX_STATE_PAYLOAD_BYTES,
      preview,
    };
  }

  return coerced;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------------ */
/*  LLM response extraction — port of `_extract_token_usage` / `_extract_model` */
/* ------------------------------------------------------------------------ */

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function firstGenerationMessage(
  response: LLMResultLike | null | undefined,
): BaseMessageLike | undefined {
  const gens = response?.generations;
  if (Array.isArray(gens) && gens.length > 0 && Array.isArray(gens[0]) && gens[0]!.length > 0) {
    return gens[0]![0]!.message;
  }
  return undefined;
}

/**
 * Returns token usage across the provider shapes LangChain JS integrations
 * use in practice. Field names below are snake_case because — unlike most
 * of the JS ecosystem — `@langchain/core`'s `usage_metadata` /
 * `response_metadata` fields ARE snake_case (verified against
 * `@langchain/core/dist/messages/ai.d.ts`), matching the Python SDK 1:1.
 * `llmOutput` is a free-form provider bag; we also check the camelCase
 * `tokenUsage` key the existing `../langgraph/` adapter established.
 */
export function extractTokenUsage(response: LLMResultLike | null | undefined): TokenUsage {
  try {
    const msg = firstGenerationMessage(response);
    if (msg) {
      const um = msg.usage_metadata;
      if (um && (um.input_tokens !== undefined || um.output_tokens !== undefined)) {
        const details = um.input_token_details ?? {};
        const cached = details.cache_read ?? details.cache_creation;
        return {
          inputTokens: numOrUndef(um.input_tokens),
          outputTokens: numOrUndef(um.output_tokens),
          totalTokens: numOrUndef(um.total_tokens),
          cachedInputTokens: numOrUndef(cached),
        };
      }
      const tokenUsage = msg.response_metadata?.token_usage;
      if (tokenUsage) {
        return {
          inputTokens: numOrUndef(tokenUsage.prompt_tokens ?? tokenUsage.input_tokens),
          outputTokens: numOrUndef(tokenUsage.completion_tokens ?? tokenUsage.output_tokens),
          totalTokens: numOrUndef(tokenUsage.total_tokens),
        };
      }
    }
  } catch {
    // fall through to llmOutput-based extraction
  }

  const llmOutput = response?.llmOutput ?? {};
  const tokenUsage = (llmOutput.tokenUsage ?? llmOutput.token_usage) as
    | Record<string, unknown>
    | undefined;
  if (tokenUsage && Object.keys(tokenUsage).length > 0) {
    return {
      inputTokens: numOrUndef(
        tokenUsage.promptTokens ??
          tokenUsage.prompt_tokens ??
          tokenUsage.inputTokens ??
          tokenUsage.input_tokens,
      ),
      outputTokens: numOrUndef(
        tokenUsage.completionTokens ??
          tokenUsage.completion_tokens ??
          tokenUsage.outputTokens ??
          tokenUsage.output_tokens,
      ),
      totalTokens: numOrUndef(tokenUsage.totalTokens ?? tokenUsage.total_tokens),
    };
  }

  const usage = llmOutput.usage as Record<string, unknown> | undefined;
  if (usage && Object.keys(usage).length > 0) {
    return {
      inputTokens: numOrUndef(usage.input_tokens),
      outputTokens: numOrUndef(usage.output_tokens),
      totalTokens: numOrUndef(usage.total_tokens),
      cachedInputTokens: numOrUndef(usage.cache_read_input_tokens),
    };
  }

  return {};
}

/** Best-effort model-name extraction from an `LLMResult`. */
export function extractModel(response: LLMResultLike | null | undefined): string | undefined {
  try {
    const msg = firstGenerationMessage(response);
    const meta = msg?.response_metadata;
    const model = meta?.model_name ?? meta?.model;
    if (typeof model === "string" && model.length > 0) return model;
  } catch {
    // fall through
  }
  const llmOutput = response?.llmOutput ?? {};
  const model = llmOutput.model_name ?? llmOutput.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/** Best-effort output-text extraction from an `LLMResult`, for `output_data.text`. */
export function extractOutputText(response: LLMResultLike | null | undefined): string {
  try {
    const gens = response?.generations;
    if (Array.isArray(gens) && gens.length > 0 && Array.isArray(gens[0]) && gens[0]!.length > 0) {
      const first = gens[0]![0]!;
      if (typeof first.text === "string" && first.text.length > 0) return first.text;
      const content = first.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (typeof block === "string") {
            parts.push(block);
          } else if (
            block &&
            typeof block === "object" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            parts.push((block as Record<string, unknown>).text as string);
          }
        }
        return parts.join("\n");
      }
    }
  } catch {
    // fall through
  }
  return "";
}

/* ------------------------------------------------------------------------ */
/*  MorseCallbackHandler                                                    */
/* ------------------------------------------------------------------------ */

export class MorseCallbackHandler implements CallbackHandlerSurface {
  /** Required by LangChain's `BaseCallbackHandler` interface. */
  public readonly name: string = HANDLER_NAME;

  public readonly agentName: string;

  /** Map of `runId` → open `SpanHandle`, spanning chain/llm/tool/retriever
   * spans together (mirrors Python's single `_span_stack` dict). */
  private readonly spanStack: Map<string, SpanHandle> = new Map();

  constructor(options?: MorseCallbackHandlerOptions) {
    this.agentName =
      options?.agentName && options.agentName.length > 0 ? options.agentName : DEFAULT_AGENT_NAME;
  }

  /* ---------------------------------------------------------------------- */
  /*  Internal helpers                                                      */
  /* ---------------------------------------------------------------------- */

  private openSpan(
    runId: string,
    name: string,
    type: "agent" | "llm" | "tool" | "retriever",
    inputData?: unknown,
    extraMetadata?: Record<string, unknown>,
  ): SpanHandle | null {
    if (typeof runId !== "string" || runId.length === 0) return null;
    const metadata: Record<string, unknown> = { ...(extraMetadata ?? {}), adapter: ADAPTER };
    const handle = startSpan({ name, type, metadata });
    if (handle === null) return null;
    const wrapped = coerceStateValue(inputData);
    if (wrapped !== undefined) handle.span.input_data = wrapped;
    this.spanStack.set(runId, handle);
    return handle;
  }

  private closeSpan(runId: string, outputData?: unknown, error?: unknown): void {
    const handle = this.spanStack.get(runId);
    if (handle === undefined) return;
    this.spanStack.delete(runId);
    if (outputData !== undefined) {
      const wrapped = coerceStateValue(outputData);
      if (wrapped !== undefined) handle.span.output_data = wrapped;
    }
    if (error !== undefined) {
      handle.end(error);
    } else {
      handle.end();
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Chain callbacks                                                       */
  /* ---------------------------------------------------------------------- */

  // NOTE: trailing `runType`/`runName` parameters from
  // `CallbackHandlerSurface` are intentionally omitted below (not just
  // underscore-prefixed) — this adapter doesn't use them, and TypeScript
  // structural typing allows an implementing function to declare fewer
  // parameters than its interface signature. Declaring-then-ignoring
  // trailing unused params trips `@typescript-eslint/no-unused-vars`'s
  // default `args: "after-used"` mode (only params before the last *used*
  // one are exempt); omitting them entirely is both lint-clean and reads
  // as "these truly aren't consulted." `metadata` IS consulted as of
  // MHQ-1029, so it and the params before it are declared.

  handleChainStart(
    chain: SerializedLike,
    inputs: Record<string, unknown>,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    _handleChainStart(this, chain, inputs, runId, metadata);
  }

  handleChainEnd(outputs: Record<string, unknown>, runId: string): void {
    _handleChainEnd(this, outputs, runId);
  }

  handleChainError(err: unknown, runId: string): void {
    _handleChainError(this, err, runId);
  }

  /* ---------------------------------------------------------------------- */
  /*  LLM callbacks                                                         */
  /* ---------------------------------------------------------------------- */

  handleLLMStart(
    llm: SerializedLike,
    prompts: string[],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    _handleLLMStart(this, llm, prompts, runId, extraParams);
  }

  handleChatModelStart(
    llm: SerializedLike,
    messages: BaseMessageLike[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    // Chat models ARE LLMs — same span type as handleLLMStart (mirrors
    // Python's LangGraph override; the plain-LangChain adapter treats both
    // identically since it has no chat-model-specific behavior to add).
    // MHQ-750: also decompose the flattened messages (+ bound tools, if
    // any) into context_segments — mirrors `../langgraph/`'s
    // handleChatModelStart wiring via the same shared decomposer.
    _handleChatModelStart(this, llm, messages, runId, extraParams);
  }

  handleLLMEnd(output: LLMResultLike, runId: string): void {
    _handleLLMEnd(this, output, runId);
  }

  handleLLMError(err: unknown, runId: string): void {
    _handleLLMError(this, err, runId);
  }

  /* ---------------------------------------------------------------------- */
  /*  Tool callbacks                                                        */
  /* ---------------------------------------------------------------------- */

  handleToolStart(tool: SerializedLike, input: string, runId: string): void {
    _handleToolStart(this, tool, input, runId);
  }

  handleToolEnd(output: unknown, runId: string): void {
    _handleToolEnd(this, output, runId);
  }

  handleToolError(err: unknown, runId: string): void {
    _handleToolError(this, err, runId);
  }

  /* ---------------------------------------------------------------------- */
  /*  Retriever callbacks (@beta — subject to change before SDK v1.0)       */
  /* ---------------------------------------------------------------------- */

  handleRetrieverStart(retriever: SerializedLike, query: string, runId: string): void {
    _handleRetrieverStart(this, retriever, query, runId);
  }

  handleRetrieverEnd(documents: DocumentLike[], runId: string): void {
    _handleRetrieverEnd(this, documents, runId);
  }

  handleRetrieverError(err: unknown, runId: string): void {
    _handleRetrieverError(this, err, runId);
  }

  /* ---------------------------------------------------------------------- */
  /*  Internal accessors used by the absorbErrorsSync-wrapped impls          */
  /* ---------------------------------------------------------------------- */

  /** @internal */
  _openSpan(
    runId: string,
    name: string,
    type: "agent" | "llm" | "tool" | "retriever",
    inputData?: unknown,
    extraMetadata?: Record<string, unknown>,
  ): SpanHandle | null {
    return this.openSpan(runId, name, type, inputData, extraMetadata);
  }

  /** @internal */
  _closeSpan(runId: string, outputData?: unknown, error?: unknown): void {
    this.closeSpan(runId, outputData, error);
  }

  /** @internal */
  _getSpan(runId: string): SpanHandle | undefined {
    return this.spanStack.get(runId);
  }
}

/* ------------------------------------------------------------------------ */
/*  Implementation bodies (wrapped in absorbErrorsSync)                     */
/* ------------------------------------------------------------------------ */

const _handleChainStart = absorbErrorsSync(
  (
    self: MorseCallbackHandler,
    chain: SerializedLike | null | undefined,
    inputs: Record<string, unknown>,
    runId: string,
    metadata?: Record<string, unknown>,
  ): void => {
    const chainName = resolveNameIdFirst(chain, "chain");
    self._openSpan(runId, chainName, "agent", inputs);
    // MHQ-1029: LangGraph copies `configurable.thread_id` onto the run
    // metadata, which is the only place a checkpointed conversation's
    // identity reaches a callback handler.
    if (metadata) adoptThreadId(metadata.thread_id ?? metadata.threadId);
  },
  { fingerprint: "morse.langchain.handleChainStart" },
) as (
  self: MorseCallbackHandler,
  chain: SerializedLike | null | undefined,
  inputs: Record<string, unknown>,
  runId: string,
  metadata?: Record<string, unknown>,
) => void;

const _handleChainEnd = absorbErrorsSync(
  (self: MorseCallbackHandler, outputs: Record<string, unknown>, runId: string): void => {
    self._closeSpan(runId, outputs);
  },
  { fingerprint: "morse.langchain.handleChainEnd" },
) as (self: MorseCallbackHandler, outputs: Record<string, unknown>, runId: string) => void;

const _handleChainError = absorbErrorsSync(
  (self: MorseCallbackHandler, err: unknown, runId: string): void => {
    self._closeSpan(runId, undefined, err ?? new Error("langchain chain error"));
  },
  { fingerprint: "morse.langchain.handleChainError" },
) as (self: MorseCallbackHandler, err: unknown, runId: string) => void;

const _handleLLMStart = absorbErrorsSync(
  (
    self: MorseCallbackHandler,
    llm: SerializedLike | null | undefined,
    prompts: string[],
    runId: string,
    extraParams: Record<string, unknown> | undefined,
  ): void => {
    const llmName = resolveNameIdFirst(llm, "llm");
    const invocationParams = extraParams?.invocation_params as Record<string, unknown> | undefined;
    const modelName =
      (typeof invocationParams?.model_name === "string"
        ? invocationParams.model_name
        : undefined) ??
      (typeof invocationParams?.model === "string" ? invocationParams.model : undefined);
    const handle = self._openSpan(
      runId,
      llmName,
      "llm",
      prompts && prompts.length > 0 ? { prompts } : undefined,
    );
    if (handle !== null && modelName) {
      handle.span.model = modelName;
    }
  },
  { fingerprint: "morse.langchain.handleLLMStart" },
) as (
  self: MorseCallbackHandler,
  llm: SerializedLike | null | undefined,
  prompts: string[],
  runId: string,
  extraParams: Record<string, unknown> | undefined,
) => void;

/**
 * `@langchain/core` passes `handleChatModelStart` a nested
 * `BaseMessage[][]` — one array per "prompt" in a batch call. The
 * decomposer expects a flat list, so flatten one level (mirrors
 * `../langgraph/llm-and-tool-callbacks.ts`'s `flattenMessages`, itself a
 * port of Python's `_flatten_messages` in `adapters/langgraph.py`).
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

/** Extract the bound `tools` array from `handleChatModelStart`'s `extraParams.invocation_params`. */
function toolsFromExtra(extra: Record<string, unknown> | undefined): unknown {
  const invocationParams = extra?.invocation_params as Record<string, unknown> | undefined;
  return invocationParams?.tools;
}

const _handleChatModelStart = absorbErrorsSync(
  (
    self: MorseCallbackHandler,
    llm: SerializedLike | null | undefined,
    messages: BaseMessageLike[][],
    runId: string,
    extraParams: Record<string, unknown> | undefined,
  ): void => {
    const llmName = resolveNameIdFirst(llm, "llm");
    const invocationParams = extraParams?.invocation_params as Record<string, unknown> | undefined;
    const modelName =
      (typeof invocationParams?.model_name === "string"
        ? invocationParams.model_name
        : undefined) ??
      (typeof invocationParams?.model === "string" ? invocationParams.model : undefined);
    const flatMessages = flattenMessages(messages);
    const contextSegments = decomposeOpenAiMessages(flatMessages, toolsFromExtra(extraParams));
    // MHQ-1156: chat-model prompts were never captured (only the raw-prompt
    // handleLLMStart path was), so the INPUT pane was empty for every chat
    // model. Same shared helper as `../langgraph/`.
    const handle = self._openSpan(runId, llmName, "llm", captureLangChainMessages(flatMessages));
    if (handle !== null) {
      if (modelName) handle.span.model = modelName;
      if (contextSegments.length > 0) handle.span.context_segments = contextSegments;
    }
  },
  { fingerprint: "morse.langchain.handleChatModelStart" },
) as (
  self: MorseCallbackHandler,
  llm: SerializedLike | null | undefined,
  messages: BaseMessageLike[][],
  runId: string,
  extraParams: Record<string, unknown> | undefined,
) => void;

const _handleLLMEnd = absorbErrorsSync(
  (self: MorseCallbackHandler, response: LLMResultLike, runId: string): void => {
    const handle = self._getSpan(runId);
    const outputText = extractOutputText(response);

    if (handle !== undefined) {
      const usage = extractTokenUsage(response);
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
        handle.span.input_tokens = usage.inputTokens;
        handle.span.output_tokens = usage.outputTokens;
        handle.span.total_tokens =
          usage.totalTokens !== undefined
            ? usage.totalTokens
            : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined;
        if (usage.cachedInputTokens) {
          handle.span.cached_input_tokens = usage.cachedInputTokens;
        }
      }
      // Response model wins over the invocation-param model set in
      // handleLLMStart — the response carries the fully-resolved version
      // string. Mirrors Python's on_llm_end behavior.
      const resolvedModel = extractModel(response);
      if (resolvedModel) {
        handle.span.model = resolvedModel;
      }
      // NOTE: cost computation (calculate_cost / merge_provider_reported_cost
      // in the Python adapter) intentionally omitted — no TS pricing module
      // exists yet (separate MHQ-482 gap). See file-header deviation notes.
    }

    self._closeSpan(runId, { text: outputText });
  },
  { fingerprint: "morse.langchain.handleLLMEnd" },
) as (self: MorseCallbackHandler, response: LLMResultLike, runId: string) => void;

const _handleLLMError = absorbErrorsSync(
  (self: MorseCallbackHandler, err: unknown, runId: string): void => {
    self._closeSpan(runId, undefined, err ?? new Error("langchain llm error"));
  },
  { fingerprint: "morse.langchain.handleLLMError" },
) as (self: MorseCallbackHandler, err: unknown, runId: string) => void;

const _handleToolStart = absorbErrorsSync(
  (
    self: MorseCallbackHandler,
    tool: SerializedLike | null | undefined,
    input: string,
    runId: string,
  ): void => {
    const toolName = resolveNameNameFirst(tool, "tool");
    self._openSpan(runId, toolName, "tool", { input });
  },
  { fingerprint: "morse.langchain.handleToolStart" },
) as (
  self: MorseCallbackHandler,
  tool: SerializedLike | null | undefined,
  input: string,
  runId: string,
) => void;

const _handleToolEnd = absorbErrorsSync(
  (self: MorseCallbackHandler, output: unknown, runId: string): void => {
    self._closeSpan(runId, { output: String(output) });
  },
  { fingerprint: "morse.langchain.handleToolEnd" },
) as (self: MorseCallbackHandler, output: unknown, runId: string) => void;

const _handleToolError = absorbErrorsSync(
  (self: MorseCallbackHandler, err: unknown, runId: string): void => {
    self._closeSpan(runId, undefined, err ?? new Error("langchain tool error"));
  },
  { fingerprint: "morse.langchain.handleToolError" },
) as (self: MorseCallbackHandler, err: unknown, runId: string) => void;

const _handleRetrieverStart = absorbErrorsSync(
  (
    self: MorseCallbackHandler,
    retriever: SerializedLike | null | undefined,
    query: string,
    runId: string,
  ): void => {
    const idPath = retriever?.id;
    const retrieverName =
      (Array.isArray(idPath) && idPath.length > 0 ? idPath[idPath.length - 1] : undefined) ||
      "retriever";
    self._openSpan(runId, String(retrieverName), "retriever", { query });
  },
  { fingerprint: "morse.langchain.handleRetrieverStart" },
) as (
  self: MorseCallbackHandler,
  retriever: SerializedLike | null | undefined,
  query: string,
  runId: string,
) => void;

const _handleRetrieverEnd = absorbErrorsSync(
  (self: MorseCallbackHandler, documents: DocumentLike[], runId: string): void => {
    const docsOut: Array<{ content_preview: string; source?: string; score?: number }> = [];
    for (const doc of documents ?? []) {
      if (doc && typeof doc === "object" && typeof doc.pageContent === "string") {
        const entry: { content_preview: string; source?: string; score?: number } = {
          content_preview: doc.pageContent.slice(0, 200),
        };
        const meta = doc.metadata;
        if (meta) {
          if (typeof meta.source === "string") entry.source = meta.source;
          const score = meta.score ?? meta.relevance_score;
          if (typeof score === "number") entry.score = score;
        }
        docsOut.push(entry);
      } else if (doc && typeof doc === "object") {
        docsOut.push(
          doc as unknown as { content_preview: string; source?: string; score?: number },
        );
      }
    }
    self._closeSpan(runId, {
      docs_count: documents?.length ?? 0,
      top_score: docsOut.length > 0 ? (docsOut[0]?.score ?? null) : null,
      sources: docsOut
        .map((d) => d.source)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
      documents: docsOut.slice(0, 10),
    });
  },
  { fingerprint: "morse.langchain.handleRetrieverEnd" },
) as (self: MorseCallbackHandler, documents: DocumentLike[], runId: string) => void;

const _handleRetrieverError = absorbErrorsSync(
  (self: MorseCallbackHandler, err: unknown, runId: string): void => {
    self._closeSpan(runId, undefined, err ?? new Error("langchain retriever error"));
  },
  { fingerprint: "morse.langchain.handleRetrieverError" },
) as (self: MorseCallbackHandler, err: unknown, runId: string) => void;

/* ------------------------------------------------------------------------ */
/*  Optional peer-dep: real BaseCallbackHandler                              */
/* ------------------------------------------------------------------------ */

async function loadLangChainCoreCallbacks(): Promise<LangChainCoreCallbacksModuleLike | null> {
  try {
    // Function-eval'd dynamic import keeps bundlers from trying to resolve
    // `@langchain/core/callbacks/base` at build time when the dep isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await (Function("m", "return import(m)") as any)(
      "@langchain/core/callbacks/base",
    )) as LangChainCoreCallbacksModuleLike;
    return mod ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort: if `@langchain/core/callbacks/base` is installed at runtime,
 * return a `MorseCallbackHandler`-shaped class whose prototype chain
 * includes the real `BaseCallbackHandler` (for users relying on
 * `instanceof BaseCallbackHandler` checks). Otherwise return the duck-typed
 * `MorseCallbackHandler` defined above. Mirrors `../langgraph/callback-handler.ts`'s
 * `getCallbackHandlerClass()`.
 */
export async function getCallbackHandlerClass(): Promise<typeof MorseCallbackHandler> {
  const mod = await loadLangChainCoreCallbacks();
  const Base = mod?.BaseCallbackHandler;
  if (!Base) return MorseCallbackHandler;

  class MorseCallbackHandlerWithBase extends (Base as unknown as {
    new (...args: unknown[]): object;
  }) {
    public readonly name: string = HANDLER_NAME;
    private readonly _av: MorseCallbackHandler;
    constructor(options?: MorseCallbackHandlerOptions) {
      super();
      this._av = new MorseCallbackHandler(options);
    }
    handleChainStart(chain: SerializedLike, inputs: Record<string, unknown>, runId: string): void {
      this._av.handleChainStart(chain, inputs, runId);
    }
    handleChainEnd(outputs: Record<string, unknown>, runId: string): void {
      this._av.handleChainEnd(outputs, runId);
    }
    handleChainError(err: unknown, runId: string): void {
      this._av.handleChainError(err, runId);
    }
    handleLLMStart(
      llm: SerializedLike,
      prompts: string[],
      runId: string,
      parentRunId?: string,
      extraParams?: Record<string, unknown>,
    ): void {
      this._av.handleLLMStart(llm, prompts, runId, parentRunId, extraParams);
    }
    handleChatModelStart(
      llm: SerializedLike,
      messages: BaseMessageLike[][],
      runId: string,
      parentRunId?: string,
      extraParams?: Record<string, unknown>,
    ): void {
      this._av.handleChatModelStart(llm, messages, runId, parentRunId, extraParams);
    }
    handleLLMEnd(output: LLMResultLike, runId: string): void {
      this._av.handleLLMEnd(output, runId);
    }
    handleLLMError(err: unknown, runId: string): void {
      this._av.handleLLMError(err, runId);
    }
    handleToolStart(tool: SerializedLike, input: string, runId: string): void {
      this._av.handleToolStart(tool, input, runId);
    }
    handleToolEnd(output: unknown, runId: string): void {
      this._av.handleToolEnd(output, runId);
    }
    handleToolError(err: unknown, runId: string): void {
      this._av.handleToolError(err, runId);
    }
    handleRetrieverStart(retriever: SerializedLike, query: string, runId: string): void {
      this._av.handleRetrieverStart(retriever, query, runId);
    }
    handleRetrieverEnd(documents: DocumentLike[], runId: string): void {
      this._av.handleRetrieverEnd(documents, runId);
    }
    handleRetrieverError(err: unknown, runId: string): void {
      this._av.handleRetrieverError(err, runId);
    }
  }
  return MorseCallbackHandlerWithBase as unknown as typeof MorseCallbackHandler;
}
