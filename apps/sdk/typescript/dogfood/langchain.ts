/**
 * Dogfood: generic LangChain JS adapter (`@amundai/sdk/langchain`).
 *
 * Runs a tiny real `ChatOpenAI` call through `@langchain/core` with a
 * `MorseCallbackHandler` attached, sends the trace to Morse dev, prints
 * the trace id, exits.
 *
 * Required env:
 *   OPENAI_API_KEY
 *   AMUND_API_KEY  (dev dogfood org)
 *
 * Optional:
 *   OPENAI_MODEL  (default: gpt-4o-mini)
 *   AMUND_ENDPOINT
 */

import { runAsync, getLastTrace } from "../src/_internal/tracing";
import { MorseCallbackHandler } from "../src/langchain";
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
  let openaiMod: any;
  try {
    openaiMod = await import("@langchain/openai");
  } catch (err) {
    console.error(
      "\n@langchain/openai is not installed.\n  cd apps/sdk/typescript && pnpm install\n",
    );
    throw err;
  }

  const { ChatOpenAI } = openaiMod;
  const llm = new ChatOpenAI({ model, apiKey: process.env.OPENAI_API_KEY });

  const handler = new MorseCallbackHandler({ agentName: "dogfood-langchain" });

  let outcome = "completed";
  try {
    await runAsync({ agentName: "dogfood-langchain" }, async () => {
      const response = await llm.invoke(
        [
          {
            role: "user",
            content: "List three short reasons developers should adopt observability.",
          },
        ],
        { callbacks: [handler] },
      );
      const text = (response as { content?: unknown })?.content;
      console.log(`[dogfood-langchain] final output: ${String(text).slice(0, 120)}`);
      return null;
    });
  } catch (err) {
    outcome = `error:${String(err).slice(0, 80)}`;
    throw err;
  }

  const trace = getLastTrace();
  const tr = trace as { trace?: { trace_id?: string }; spans?: unknown[] } | null;
  return {
    traceId: tr?.trace?.trace_id,
    spanCount: tr?.spans?.length,
    outcome,
  };
}

void runDogfood("dogfood-langchain", main);
