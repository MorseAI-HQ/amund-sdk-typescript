/**
 * Dogfood: Anthropic Claude Agent SDK adapter.
 *
 * Runs a tiny real Claude Agent SDK agent loop with the Morse
 * adapter installed, sends traces to Morse dev, prints the trace
 * id, exits.
 *
 * Required env:
 *   ANTHROPIC_API_KEY
 *   MORSE_API_KEY  (dev dogfood org)
 *
 * Optional:
 *   ANTHROPIC_MODEL  (default: claude-haiku-4-5)
 *   MORSE_ENDPOINT
 */

import { runAsync, getLastTrace } from "../src/_internal/tracing";
import { wrapClaudeAgentSDKWithFullInstrumentation } from "../src/anthropic-agent-sdk";
import { requireEnv, runDogfood } from "./_common";

interface QueryResult {
  traceId?: string;
  spanCount?: number;
  outcome?: string;
}

async function main(): Promise<QueryResult> {
  requireEnv("ANTHROPIC_API_KEY", "Get one from https://console.anthropic.com");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

  // Late import so missing peer dep gives a useful error rather than a
  // module-resolution crash at file load.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import("@anthropic-ai/claude-agent-sdk");
  } catch (err) {
    console.error(
      "\n@anthropic-ai/claude-agent-sdk is not installed.\n" +
        "  cd apps/sdk/typescript && pnpm install\n",
    );
    throw err;
  }

  // The Claude Agent SDK exposes either `ClaudeSDKClient` (class) or
  // `query` (standalone fn) — try both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawClient: any;
  if (typeof mod.ClaudeSDKClient === "function") {
    rawClient = new mod.ClaudeSDKClient({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model,
    });
  } else if (typeof mod.query === "function") {
    // Synthesize a client-like that delegates to the standalone fn.
    rawClient = {
      query: (prompt: string, opts?: Record<string, unknown>) =>
        mod.query({
          prompt,
          options: { model, maxTurns: 2, ...(opts ?? {}) },
        }),
    };
  } else {
    throw new Error("Couldn't locate ClaudeSDKClient or query() in @anthropic-ai/claude-agent-sdk");
  }

  const { client, dispose } = wrapClaudeAgentSDKWithFullInstrumentation(rawClient, {
    defaultAgentName: "dogfood-anthropic-agent-sdk",
    defaultModel: model,
  });

  let outcome = "completed";
  try {
    await runAsync({ agentName: "dogfood-anthropic-agent-sdk" }, async () => {
      let eventCount = 0;
      for await (const _event of client.query(
        "List three short reasons developers should adopt observability.",
      )) {
        void _event;
        eventCount += 1;
        if (eventCount > 200) break; // hard safety cap
      }
      console.log(`[dogfood-anthropic-agent-sdk] consumed ${eventCount} SDK events`);
      return null;
    });
  } catch (err) {
    outcome = `error:${String(err).slice(0, 80)}`;
    throw err;
  } finally {
    dispose();
  }

  const trace = getLastTrace();
  const tr = trace as { trace?: { trace_id?: string }; spans?: unknown[] } | null;
  return {
    traceId: tr?.trace?.trace_id,
    spanCount: tr?.spans?.length,
    outcome,
  };
}

void runDogfood("dogfood-anthropic-agent-sdk", main);
