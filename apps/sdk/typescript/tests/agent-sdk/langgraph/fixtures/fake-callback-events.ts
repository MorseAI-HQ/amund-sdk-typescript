/**
 * Fake LangGraph callback event sequences for unit tests across Wave 2-L tasks.
 *
 * Real LangGraph runs invoke `BaseCallbackHandler` methods in a specific
 * order. This fixture replays canonical sequences directly against an
 * `MorseCallbackHandler` instance so tests stay independent of the
 * `@langchain/core` peer dep.
 *
 * Used by:
 *   - tests/agent-sdk/langgraph/callback-handler.test.ts
 *   - tests/agent-sdk/langgraph/llm-and-tool-callbacks.test.ts
 *   - tests/agent-sdk/langgraph/streaming-and-checkpoint.test.ts
 *   - tests/agent-sdk/langgraph/integration.test.ts
 */

import type { CallbackHandlerSurface } from "../../../../src/langgraph/types";

/** Drive a handler through a canonical chain → llm → tool → end sequence. */
export async function replayHappyPath(handler: CallbackHandlerSurface): Promise<void> {
  const chainId = "chain_root";
  const llmId = "llm_1";
  const toolId = "tool_1";

  await handler.handleChainStart?.(
    { id: ["langchain", "chains", "RunnableSequence"], name: "agent" },
    { question: "what's the weather?" },
    chainId,
    undefined,
    [],
    {},
    "chain",
    "agent",
  );

  await handler.handleLLMStart?.(
    { id: ["langchain_openai", "chat_models", "ChatOpenAI"], name: "ChatOpenAI" },
    ["what's the weather?"],
    llmId,
    chainId,
  );
  await handler.handleLLMEnd?.(
    {
      generations: [[{ text: "The weather is sunny." }]],
      llmOutput: { tokenUsage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 } },
    },
    llmId,
    chainId,
  );

  await handler.handleToolStart?.(
    { id: ["langchain_core", "tools", "Tool"], name: "get_weather" },
    JSON.stringify({ city: "SF" }),
    toolId,
    chainId,
  );
  await handler.handleToolEnd?.(JSON.stringify({ temp: 65 }), toolId, chainId);

  await handler.handleChainEnd?.({ answer: "sunny, 65F" }, chainId);
}

/** Drive a handler through a nested-chain sequence (parent → child chain). */
export async function replayNestedChains(handler: CallbackHandlerSurface): Promise<void> {
  await handler.handleChainStart?.(
    { id: ["langchain", "chains", "Parent"], name: "parent" },
    {},
    "chain_parent",
  );
  await handler.handleChainStart?.(
    { id: ["langchain", "chains", "Child"], name: "child" },
    {},
    "chain_child",
    "chain_parent",
  );
  await handler.handleChainEnd?.({}, "chain_child", "chain_parent");
  await handler.handleChainEnd?.({}, "chain_parent");
}

/** Stream `n` tokens through one LLM span; assert no per-token spans emitted. */
export async function replayStreamingTokens(
  handler: CallbackHandlerSurface,
  n: number,
): Promise<void> {
  const chainId = "chain_stream";
  const llmId = "llm_stream";
  await handler.handleChainStart?.(
    { id: ["langchain", "chains", "Stream"], name: "stream_chain" },
    {},
    chainId,
  );
  await handler.handleLLMStart?.(
    { id: ["langchain_openai", "chat_models", "ChatOpenAI"], name: "ChatOpenAI" },
    ["prompt"],
    llmId,
    chainId,
  );
  for (let i = 0; i < n; i++) {
    await handler.handleLLMNewToken?.("tok", { prompt: 0, completion: i }, llmId, chainId);
  }
  await handler.handleLLMEnd?.(
    {
      generations: [[{ text: "full" }]],
      llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: n, totalTokens: 5 + n } },
    },
    llmId,
    chainId,
  );
  await handler.handleChainEnd?.({}, chainId);
}
