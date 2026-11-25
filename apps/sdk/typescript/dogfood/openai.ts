/**
 * Dogfood: raw OpenAI SDK adapter (`@amund/sdk/openai`).
 *
 * Wraps a plain `openai` client and makes one `chat.completions.create`
 * call, sends the trace to Morse dev, prints the trace id, exits.
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
import { wrapOpenAI } from "../src/openai";
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
  let mod: any;
  try {
    mod = await import("openai");
  } catch (err) {
    console.error("\nopenai is not installed.\n  cd apps/sdk/typescript && pnpm install\n");
    throw err;
  }

  const OpenAICtor = mod.default ?? mod.OpenAI;
  if (typeof OpenAICtor !== "function") {
    throw new Error("Couldn't locate the OpenAI client constructor in openai");
  }

  const rawClient = new OpenAICtor({ apiKey: process.env.OPENAI_API_KEY });
  const client = wrapOpenAI(rawClient);

  let outcome = "completed";
  try {
    await runAsync({ agentName: "dogfood-openai" }, async () => {
      const response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: "List three short reasons developers should adopt observability.",
          },
        ],
      });
      const text = (response as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content;
      console.log(`[dogfood-openai] final output: ${String(text).slice(0, 120)}`);
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

void runDogfood("dogfood-openai", main);
