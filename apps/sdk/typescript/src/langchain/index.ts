/**
 * `@amund/sdk/langchain` — adapter for plain `@langchain/core` (chains,
 * LLMs, tools, retrievers) as distinct from `@amund/sdk/langgraph`
 * (LangGraph's graph-execution model).
 *
 * MHQ-482: port of `apps/sdk/python/src/morse_ai/adapters/langchain.py`.
 *
 * ```ts
 * import { MorseCallbackHandler } from "@amund/sdk/langchain";
 * import * as morse from "@amund/sdk";
 *
 * const handler = new MorseCallbackHandler({ agentName: "my-agent" });
 * await morse.run({ agentName: "my-agent" }, async () => {
 *   await chain.invoke(input, { callbacks: [handler] });
 * });
 * ```
 *
 * See `callback-handler.ts`'s file-header for the full deviation notes
 * versus the Python adapter (no auto-trace creation, no subclass
 * relationship with `../langgraph/`, no cost computation yet).
 */

export {
  MorseCallbackHandler,
  coerceStateValue,
  extractModel,
  extractOutputText,
  extractTokenUsage,
  getCallbackHandlerClass,
} from "./callback-handler";

export type { MorseCallbackHandlerOptions, TokenUsage } from "./callback-handler";

export type {
  BaseMessageLike,
  CallbackHandlerSurface,
  DocumentLike,
  GenerationLike,
  LangChainCoreCallbacksModuleLike,
  LLMResultLike,
  SerializedLike,
} from "./types";
