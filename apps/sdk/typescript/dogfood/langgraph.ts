/**
 * Dogfood: LangGraph JS adapter.
 *
 * Builds a small StateGraph with one LLM node, invokes it with the
 * MorseCallbackHandler attached, and sends traces to Morse dev.
 *
 * Required env:
 *   OPENAI_API_KEY      (LangChain uses OpenAI here by default)
 *   MORSE_API_KEY  (dev dogfood org)
 *
 * Optional:
 *   OPENAI_MODEL  (default: gpt-4o-mini)
 *   MORSE_ENDPOINT
 */

import { runAsync, getLastTrace } from "../src/_internal/tracing";
import { MorseCallbackHandler } from "../src/langgraph";
import { requireEnv, runDogfood } from "./_common";

interface QueryResult {
  traceId?: string;
  spanCount?: number;
  outcome?: string;
}

async function main(): Promise<QueryResult> {
  requireEnv("OPENAI_API_KEY", "Get one from https://platform.openai.com");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let langgraphMod: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openaiMod: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let coreMessagesMod: any;
  try {
    langgraphMod = await import("@langchain/langgraph");
    openaiMod = await import("@langchain/openai");
    coreMessagesMod = await import("@langchain/core/messages");
  } catch (err) {
    console.error(
      "\nLangGraph deps not installed.\n" + "  cd apps/sdk/typescript && pnpm install\n",
    );
    throw err;
  }

  const { StateGraph, START, END, Annotation } = langgraphMod;
  const { ChatOpenAI } = openaiMod;
  const { HumanMessage } = coreMessagesMod;

  // Minimal state: a list of messages.
  const State = Annotation.Root({
    messages: Annotation<unknown[]>({
      reducer: (a: unknown[], b: unknown[]) => [...a, ...b],
      default: () => [],
    }),
  });

  const llm = new ChatOpenAI({
    model,
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
    maxTokens: 80,
  });

  async function callModel(state: { messages: unknown[] }): Promise<{ messages: unknown[] }> {
    const response = await llm.invoke(state.messages);
    return { messages: [response] };
  }

  const graph = new StateGraph(State)
    .addNode("model", callModel)
    .addEdge(START, "model")
    .addEdge("model", END)
    .compile();

  const handler = new MorseCallbackHandler({
    defaultAgentName: "dogfood-langgraph",
  });

  let outcome = "completed";
  try {
    await runAsync({ agentName: "dogfood-langgraph" }, async () => {
      const result = await graph.invoke(
        { messages: [new HumanMessage("Reply with the single word: pong.")] },
        // MHQ-1029: `configurable.thread_id` is what a checkpointed LangGraph
        // conversation actually passes, and the adapter reads it off the run
        // metadata LangGraph derives from it. Sent here so the dogfood proves
        // that propagation against the real package rather than a mock.
        { callbacks: [handler], configurable: { thread_id: "dogfood-langgraph-thread" } },
      );
      const lastMsg = (result.messages as Array<{ content?: unknown }>).slice(-1)[0];
      console.log(`[dogfood-langgraph] final message: ${String(lastMsg?.content).slice(0, 120)}`);
      return null;
    });
  } catch (err) {
    outcome = `error:${String(err).slice(0, 80)}`;
    throw err;
  }

  const trace = getLastTrace();
  const tr = trace as {
    trace?: { trace_id?: string; thread_id?: string };
    spans?: unknown[];
  } | null;
  console.log(`[dogfood-langgraph] thread_id on trace: ${tr?.trace?.thread_id ?? "(none)"}`);
  return {
    traceId: tr?.trace?.trace_id,
    spanCount: tr?.spans?.length,
    outcome,
  };
}

void runDogfood("dogfood-langgraph", main);
