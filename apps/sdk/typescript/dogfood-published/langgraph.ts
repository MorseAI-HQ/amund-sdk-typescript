import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { runTraced } from "@morsehq-dev/sdk";
import { MorseCallbackHandler } from "@morsehq-dev/sdk/langgraph";
import { requireEnv, runDogfood } from "./_common.js";

async function main() {
  requireEnv("OPENAI_API_KEY");

  const State = Annotation.Root({
    messages: Annotation<unknown[]>({
      reducer: (a: unknown[], b: unknown[]) => [...a, ...b],
      default: () => [],
    }),
  });

  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
    maxTokens: 80,
  });

  const graph = new StateGraph(State)
    .addNode("model", async (state: { messages: unknown[] }) => ({
      messages: [await llm.invoke(state.messages as Parameters<typeof llm.invoke>[0])],
    }))
    .addEdge(START, "model")
    .addEdge("model", END)
    .compile();

  const handler = new MorseCallbackHandler({ defaultAgentName: "pub-e2e-ts-langgraph" });

  await runTraced({ agentName: "pub-e2e-ts-langgraph" }, async () => {
    const result = await graph.invoke(
      { messages: [new HumanMessage("Reply with the single word: pong.")] },
      { callbacks: [handler] },
    );
    const last = (result.messages as Array<{ content?: unknown }>).slice(-1)[0];
    console.log(`  reply: ${String(last?.content).slice(0, 100)}`);
    return null;
  });
  return { outcome: "completed" };
}

void runDogfood("pub-e2e-ts-langgraph", main);
