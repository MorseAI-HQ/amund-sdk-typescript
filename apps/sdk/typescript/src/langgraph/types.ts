/**
 * Structural types for `@langchain/langgraph` (langgraphjs) + `@langchain/core`
 * callback handlers.
 *
 * No hard import — both are optional peer deps. We mirror the
 * `BaseCallbackHandler` method surface our `MorseCallbackHandler`
 * needs to extend (or duck-type when the base class isn't installed).
 */

/** Subset of `Serialized` from `@langchain/core/load/serializable`. */
export interface SerializedLike {
  id?: string[]; // class identity path, e.g. ["langchain","chains","SequentialChain"]
  name?: string;
  kwargs?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Subset of `LLMResult` from `@langchain/core/outputs`. */
export interface LLMResultLike {
  generations?: Array<Array<{ text?: string; [k: string]: unknown }>>;
  llmOutput?: {
    tokenUsage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Subset of `BaseMessage` shape passed to `handleChatModelStart`. */
export interface BaseMessageLike {
  _getType?(): string;
  content?: string | unknown[];
  [k: string]: unknown;
}

/**
 * The methods we override on `BaseCallbackHandler`. We list them with
 * loose signatures because the real base class is conditionally imported.
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
  handleChainError?(err: unknown, runId: string, parentRunId?: string): void | Promise<void>;
  handleLLMStart?(
    llm: SerializedLike,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extra?: Record<string, unknown>,
  ): void | Promise<void>;
  handleChatModelStart?(
    llm: SerializedLike,
    messages: BaseMessageLike[][],
    runId: string,
    parentRunId?: string,
    extra?: Record<string, unknown>,
  ): void | Promise<void>;
  handleLLMEnd?(output: LLMResultLike, runId: string, parentRunId?: string): void | Promise<void>;
  handleLLMError?(err: unknown, runId: string, parentRunId?: string): void | Promise<void>;
  handleLLMNewToken?(
    token: string,
    idx: { prompt: number; completion: number },
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): void | Promise<void>;
  handleToolStart?(
    tool: SerializedLike,
    input: string,
    runId: string,
    parentRunId?: string,
  ): void | Promise<void>;
  handleToolEnd?(output: string, runId: string, parentRunId?: string): void | Promise<void>;
  handleToolError?(err: unknown, runId: string, parentRunId?: string): void | Promise<void>;
}

/** Module-shape probe for `@langchain/core/callbacks/base`. */
export interface LangChainCoreCallbacksModuleLike {
  BaseCallbackHandler?: {
    new (...args: unknown[]): CallbackHandlerSurface & { name: string };
    prototype: CallbackHandlerSurface;
  };
  [k: string]: unknown;
}
