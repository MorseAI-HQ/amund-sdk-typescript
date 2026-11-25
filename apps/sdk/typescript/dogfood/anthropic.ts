/**
 * Dogfood: raw Anthropic SDK adapter (`@amund/sdk/anthropic`).
 *
 * Wraps a plain `@anthropic-ai/sdk` client and makes one `messages.create`
 * call, sends the trace to Morse dev, prints the trace id, exits.
 *
 * Required env:
 *   ANTHROPIC_API_KEY
 *   AMUND_API_KEY  (dev dogfood org)
 *
 * Optional:
 *   ANTHROPIC_MODEL  (default: claude-haiku-4-5)
 *   AMUND_ENDPOINT
 */

import { runAsync, getLastTrace } from "../src/_internal/tracing";
import { wrapAnthropic } from "../src/anthropic";
import { requireEnv, runDogfood } from "./_common";

interface QueryResult {
  traceId?: string;
  spanCount?: number;
  outcome?: string;
}

async function main(): Promise<QueryResult> {
  requireEnv("ANTHROPIC_API_KEY", "Get one from https://console.anthropic.com");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import("@anthropic-ai/sdk");
  } catch (err) {
    console.error(
      "\n@anthropic-ai/sdk is not installed.\n  cd apps/sdk/typescript && pnpm install\n",
    );
    throw err;
  }

  const AnthropicCtor = mod.default ?? mod.Anthropic;
  if (typeof AnthropicCtor !== "function") {
    throw new Error("Couldn't locate the Anthropic client constructor in @anthropic-ai/sdk");
  }

  const rawClient = new AnthropicCtor({ apiKey: process.env.ANTHROPIC_API_KEY });
  const client = wrapAnthropic(rawClient);

  let outcome = "completed";
  try {
    await runAsync({ agentName: "dogfood-anthropic" }, async () => {
      const response = await client.messages.create({
        model,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: "List three short reasons developers should adopt observability.",
          },
        ],
      });
      const text = (response as { content?: Array<{ type?: string; text?: string }> })?.content
        ?.map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      console.log(`[dogfood-anthropic] final output: ${String(text).slice(0, 120)}`);
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

void runDogfood("dogfood-anthropic", main);
