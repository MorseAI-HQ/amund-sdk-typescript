/**
 * Dogfood: OpenAI Agents SDK adapter.
 *
 * Runs a tiny real OpenAI Agents `Runner` with one Agent + one tool
 * with the Morse adapter installed.
 *
 * Required env:
 *   OPENAI_API_KEY
 *   MORSE_API_KEY  (dev dogfood org)
 *
 * Optional:
 *   OPENAI_MODEL  (default: gpt-4o-mini)
 *   MORSE_ENDPOINT
 */

import { runAsync, getLastTrace } from "../src/_internal/tracing";
import { wrapRunnerWithFullInstrumentation } from "../src/openai-agents";
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
    mod = await import("@openai/agents");
  } catch (err) {
    console.error(
      "\n@openai/agents is not installed.\n" + "  cd apps/sdk/typescript && pnpm install\n",
    );
    throw err;
  }

  if (typeof mod.Agent !== "function" || typeof mod.run !== "function") {
    throw new Error("Couldn't locate Agent class or run() helper in @openai/agents");
  }

  // Define a small agent with a tool.

  const tool =
    typeof mod.tool === "function"
      ? mod.tool({
          name: "current_time",
          description: "Return the current ISO timestamp.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => new Date().toISOString(),
        })
      : undefined;

  const agent = new mod.Agent({
    name: "dogfood-time-bot",
    model,
    instructions:
      "You are a terse assistant. When asked the time, call the current_time tool and report what it returns.",
    tools: tool ? [tool] : [],
  });

  // The Agents SDK exposes both `Runner` class and free `run()` helper.
  // Wrap the Runner if it exists; otherwise synthesize a runner-like
  // around the free `run()` so our adapter can attach.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawRunner: any;
  if (typeof mod.Runner === "function") {
    rawRunner = new mod.Runner();
  } else {
    rawRunner = {
      run: (a: unknown, input: unknown, opts?: unknown) => mod.run(a, input, opts),
      // Adapter no-ops cleanly when on/off are absent.
    };
  }

  const { runner, dispose } = wrapRunnerWithFullInstrumentation(rawRunner, {
    defaultAgentName: "dogfood-openai-agents",
  });

  let outcome = "completed";
  try {
    await runAsync({ agentName: "dogfood-openai-agents" }, async () => {
      // MHQ-1029: pass a ChatKit-shaped run context so the dogfood proves the
      // adapter lifts the conversation id off it against the real package —
      // that context branch is the one the Python ticket (MHQ-1022) was filed
      // for, and a mock cannot tell us the SDK forwards the 3rd argument.
      const result = await runner.run(agent, "What time is it right now?", {
        context: { thread: { id: "dogfood-openai-agents-thread" } },
      });
      const out = (result as { finalOutput?: unknown })?.finalOutput;
      console.log(`[dogfood-openai-agents] final output: ${String(out).slice(0, 120)}`);
      return null;
    });
  } catch (err) {
    outcome = `error:${String(err).slice(0, 80)}`;
    throw err;
  } finally {
    dispose();
  }

  const trace = getLastTrace();
  const tr = trace as {
    trace?: { trace_id?: string; thread_id?: string };
    spans?: unknown[];
  } | null;
  console.log(`[dogfood-openai-agents] thread_id on trace: ${tr?.trace?.thread_id ?? "(none)"}`);
  return {
    traceId: tr?.trace?.trace_id,
    spanCount: tr?.spans?.length,
    outcome,
  };
}

void runDogfood("dogfood-openai-agents", main);
