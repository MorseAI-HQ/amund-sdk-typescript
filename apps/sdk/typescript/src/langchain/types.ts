/**
 * Structural types for `@langchain/core` (plain LangChain — chains, LLMs,
 * tools, retrievers) callback handlers.
 *
 * MHQ-482: port of `apps/sdk/python/src/morse_ai/adapters/langchain.py`.
 *
 * No hard import — `@langchain/core` is an optional peer dep. We mirror the
 * `BaseCallbackHandler` method surface our `MorseCallbackHandler` needs to
 * implement (or duck-type when the base class isn't installed). Verified
 * against `@langchain/core/dist/callbacks/base.d.ts` — method names and
 * argument order match exactly (this is the SAME base class LangGraph JS's
 * `MorseCallbackHandler` in `../langgraph/` implements; the two adapters
 * are structurally siblings, not a subclass relationship, because
 * `@langchain/core`'s `BaseCallbackHandler` surface is identical whether a
 * handler is registered on a plain chain or a LangGraph graph).
 */

/** Subset of `Serialized` from `@langchain/core/load/serializable`. */
export interface SerializedLike {
  id?: string[]; // class identity path, e.g. ["langchain","chains","SequentialChain"]
  name?: string;
  kwargs?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Subset of `BaseMessage` shape passed on `LLMResult.generations[].message`. */
export interface BaseMessageLike {
  content?: string | unknown[];
  /** LC v0.3 standard usage shape — snake_case, matches the Python SDK. */
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_token_details?: { cache_read?: number; cache_creation?: number; [k: string]: unknown };
    [k: string]: unknown;
  };
  response_metadata?: {
    model_name?: string;
    model?: string;
    token_usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Subset of `Generation` / `ChatGeneration` from `@langchain/core/outputs`. */
export interface GenerationLike {
  text?: string;
  message?: BaseMessageLike;
  [k: string]: unknown;
}

/** Subset of `LLMResult` from `@langchain/core/outputs`. */
export interface LLMResultLike {
  generations?: GenerationLike[][];
  llmOutput?: {
    tokenUsage?: Record<string, unknown>;
    token_usage?: Record<string, unknown>;
    usage?: Record<string, unknown>;
    model_name?: string;
    model?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Subset of `DocumentInterface` from `@langchain/core/documents`. */
export interface DocumentLike {
  pageContent?: string;
  metadata?: {
    source?: string;
    score?: number;
    relevance_score?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * The methods we implement from `BaseCallbackHandler`. Loose signatures
 * because the real base class is conditionally imported; argument order
 * mirrors `@langchain/core/dist/callbacks/base.d.ts` exactly.
 */
export interface CallbackHandlerSurface {
  handleChainStart?(
    chain: SerializedLike,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
  ): void | Promise<void>;
  handleChainEnd?(
    outputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: Record<string, unknown>,
  ): void | Promise<void>;
  handleChainError?(
    err: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: Record<string, unknown>,
  ): void | Promise<void>;
  handleLLMStart?(
    llm: SerializedLike,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void | Promise<void>;
  handleChatModelStart?(
    llm: SerializedLike,
    messages: BaseMessageLike[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void | Promise<void>;
  handleLLMEnd?(
    output: LLMResultLike,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    extraParams?: Record<string, unknown>,
  ): void | Promise<void>;
  handleLLMError?(
    err: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    extraParams?: Record<string, unknown>,
  ): void | Promise<void>;
  handleToolStart?(
    tool: SerializedLike,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): void | Promise<void>;
  handleToolEnd?(
    output: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): void | Promise<void>;
  handleToolError?(
    err: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): void | Promise<void>;
  handleRetrieverStart?(
    retriever: SerializedLike,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): void | Promise<void>;
  handleRetrieverEnd?(
    documents: DocumentLike[],
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): void | Promise<void>;
  handleRetrieverError?(
    err: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): void | Promise<void>;
}

/** Module-shape probe for `@langchain/core/callbacks/base`. */
export interface LangChainCoreCallbacksModuleLike {
  BaseCallbackHandler?: {
    new (...args: unknown[]): CallbackHandlerSurface & { name: string };
    prototype: CallbackHandlerSurface;
  };
  [k: string]: unknown;
}
