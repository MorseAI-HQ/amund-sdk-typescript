/**
 * `@morsehq-dev/sdk/langchain` — adapter for plain `@langchain/core` (chains,
 * LLMs, tools, retrievers) as distinct from `@morsehq-dev/sdk/langgraph`
 * (LangGraph's graph-execution model).
 *
 * MHQ-482: port of `apps/sdk/python/src/morse_ai/adapters/langchain.py`.
 *
 * ```ts
 * import { MorseCallbackHandler } from "@morsehq-dev/sdk/langchain";
 * import { runAsync } from "@morsehq-dev/sdk";
 *
 * const handler = new MorseCallbackHandler({ agentName: "my-agent" });
 * await runAsync({ agentName: "my-agent" }, async () => {
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
