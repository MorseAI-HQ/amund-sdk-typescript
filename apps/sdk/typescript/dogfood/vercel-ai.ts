/**
 * Dogfood: Vercel AI SDK adapter.
 *
 * MHQ-758: resolves traced replacement functions via createTracedVercelAI()
 * and calls those instead of `ai`'s own exports (`ai`'s named exports can't
 * be patched in place — see `src/vercel-ai/index.ts`'s module doc). Runs
 * one real `generateText` call through `@ai-sdk/openai`; the returned
 * function self-wraps in runAsync — no manual span management needed,
 * unlike the other three dogfood scripts.
 *
 * Required env:
 *   OPENAI_API_KEY
 *   MORSE_API_KEY  (dev dogfood org)
 *
 * Optional:
 *   OPENAI_MODEL  (default: gpt-4o-mini)
 *   MORSE_ENDPOINT
 */

import { getLastTrace } from "../src/_internal/tracing";
import { createTracedVercelAI } from "../src/vercel-ai/index";
import { requireEnv, runDogfood } from "./_common";

interface QueryResult {
  traceId?: string;
  spanCount?: number;
  outcome?: string;
}

async function main(): Promise<QueryResult> {
  requireEnv("OPENAI_API_KEY", "Get one from https://platform.openai.com");
  const modelId = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const { openai } = await import("@ai-sdk/openai");
  const { generateText } = await createTracedVercelAI({ patchGlobalFetch: false });

  let outcome = "completed";
  try {
    const result = (await generateText({
      model: openai(modelId),
      prompt: "List three short reasons developers should adopt observability.",
    })) as { text: string };
    console.log(`[dogfood-vercel-ai] final output: ${result.text.slice(0, 120)}`);
  } catch (err) {
    outcome = `error:${String(err).slice(0, 80)}`;
    throw err;
  }

  // The adapter's own runAsync wrapper resolves asynchronously after the
  // call returns — give the trace a moment to land before we read it.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const trace = getLastTrace();
  const tr = trace as { trace?: { trace_id?: string }; spans?: unknown[] } | null;
  return {
    traceId: tr?.trace?.trace_id,
    spanCount: tr?.spans?.length,
    outcome,
  };
}

void runDogfood("dogfood-vercel-ai", main);
