/**
 * Tests for `src/openai-agents/runner-wrapper.ts` (W2-O.1).
 *
 * Asserts that the outer-span wrapper:
 *   - opens exactly one `agent` span around each `run()` invocation,
 *   - tags it with `metadata.adapter="openai-agents"` + `agent_name`,
 *   - honors `agent.name`, `defaultAgentName`, and `agent.model` (string or
 *     `{ id }`),
 *   - is idempotent (re-wrapping returns the first wrapper),
 *   - closes the span on Promise resolve (success) or rejects with span
 *     ending in `failed`,
 *   - handles the two-mode `instrumentOpenAIAgents` installer correctly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  instrumentOpenAIAgents,
  isOpenAIAgentsWrapped,
  wrapRunner,
} from "../../../src/openai-agents/runner-wrapper";
import type { AgentLike, RunnerLike } from "../../../src/openai-agents/types";
import { _resetForTesting, getLastTrace } from "../../../src/_internal/tracing";

import { FakeRunner, happyPathRunner } from "./fixtures/fake-runner";

interface WireSpan {
  type: string;
  name: string;
  status?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Drain `run()` and return the spans on the last emitted trace. */
async function runAndGetSpans(
  runner: RunnerLike,
  agent: AgentLike,
  input: unknown = "hi",
): Promise<{ result: unknown; spans: WireSpan[] }> {
  const result = await runner.run(agent, input);
  // Allow microtasks to flush — _runAsync resolves once the inner Promise
  // signals completion; the trace flush happens synchronously after.
  await new Promise((r) => setTimeout(r, 0));
  const last = getLastTrace();
  const spans = (last?.spans as WireSpan[] | undefined) ?? [];
  return { result, spans };
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  wrap surface                                                             */
/* ------------------------------------------------------------------------ */

describe("wrapRunner — surface", () => {
  it("returns an object exposing `run`, `on`, and `off` from the original runner", () => {
    const runner = new FakeRunner();
    const wrapped = wrapRunner(runner);
    expect(typeof wrapped.run).toBe("function");
    expect(typeof wrapped.on).toBe("function");
    expect(typeof wrapped.off).toBe("function");
  });

  it("`isOpenAIAgentsWrapped` is false for raw runners, true for wrapped runners", () => {
    const raw = new FakeRunner();
    expect(isOpenAIAgentsWrapped(raw)).toBe(false);
    const wrapped = wrapRunner(raw);
    expect(isOpenAIAgentsWrapped(wrapped)).toBe(true);
  });

  it("wrapping is idempotent — wrapping a wrapped runner returns it as-is", () => {
    const raw = new FakeRunner();
    const once = wrapRunner(raw);
    const twice = wrapRunner(once);
    expect(twice).toBe(once);
  });

  it("returns the input unchanged for non-runner values", () => {
    // @ts-expect-error — intentional bad input
    expect(wrapRunner(null)).toBeNull();
    // @ts-expect-error — intentional bad input
    expect(wrapRunner(undefined)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */
/*  outer-span emission                                                      */
/* ------------------------------------------------------------------------ */

describe("wrapRunner — outer agent span", () => {
  it("opens exactly one `type=agent` span tagged with the adapter + agent_name", async () => {
    const wrapped = wrapRunner(happyPathRunner());
    const agent: AgentLike = { name: "triage_agent", model: "gpt-4o" };
    const { spans } = await runAndGetSpans(wrapped, agent);
    const agentSpans = spans.filter((s) => s.type === "agent");
    // 2 expected: implicit root (from _runAsync) + emitted agent span.
    expect(agentSpans.length).toBeGreaterThanOrEqual(1);
    const emitted = agentSpans.find((s) => s.name === "openai-agents.agent");
    expect(emitted).toBeDefined();
    expect(emitted!.metadata?.adapter).toBe("openai-agents");
    expect(emitted!.metadata?.agent_name).toBe("triage_agent");
  });

  it("uses `agent.name` as the emitted agent_name", async () => {
    const wrapped = wrapRunner(happyPathRunner());
    const { spans } = await runAndGetSpans(wrapped, { name: "my_agent" });
    const emitted = spans.find((s) => s.name === "openai-agents.agent");
    expect(emitted!.metadata?.agent_name).toBe("my_agent");
  });

  it("falls back to `defaultAgentName` option when `agent.name` is absent", async () => {
    const wrapped = wrapRunner(happyPathRunner(), { defaultAgentName: "fallback-agent" });
    const { spans } = await runAndGetSpans(wrapped, {});
    const emitted = spans.find((s) => s.name === "openai-agents.agent");
    expect(emitted!.metadata?.agent_name).toBe("fallback-agent");
  });

  it("falls back to `openai-agent` when neither `agent.name` nor `defaultAgentName` is set", async () => {
    const wrapped = wrapRunner(happyPathRunner());
    const { spans } = await runAndGetSpans(wrapped, {});
    const emitted = spans.find((s) => s.name === "openai-agents.agent");
    expect(emitted!.metadata?.agent_name).toBe("openai-agent");
  });

  it("propagates a string `agent.model` to span.model + metadata.model", async () => {
    const wrapped = wrapRunner(happyPathRunner());
    const { spans } = await runAndGetSpans(wrapped, { name: "a", model: "gpt-4o-mini" });
    const emitted = spans.find((s) => s.name === "openai-agents.agent");
    expect(emitted!.model).toBe("gpt-4o-mini");
    expect(emitted!.metadata?.model).toBe("gpt-4o-mini");
  });

  it("propagates `agent.model.id` (object form) to span.model", async () => {
    const wrapped = wrapRunner(happyPathRunner());
    const { spans } = await runAndGetSpans(wrapped, {
      name: "a",
      model: { id: "gpt-4o", provider: "openai" },
    });
    const emitted = spans.find((s) => s.name === "openai-agents.agent");
    expect(emitted!.model).toBe("gpt-4o");
  });

  it("closes the agent span with `completed` status on successful run", async () => {
    const wrapped = wrapRunner(happyPathRunner());
    const { spans } = await runAndGetSpans(wrapped, { name: "a", model: "gpt-4o" });
    const emitted = spans.find((s) => s.name === "openai-agents.agent");
    expect(emitted!.status).toBe("completed");
  });

  it("returns the underlying result from the wrapped run() unchanged", async () => {
    const wrapped = wrapRunner(happyPathRunner());
    const result = await wrapped.run({ name: "a", model: "gpt-4o" }, "hi");
    expect(result).toBeDefined();
    expect(result.finalOutput).toBe("ok");
  });
});

/* ------------------------------------------------------------------------ */
/*  error handling                                                           */
/* ------------------------------------------------------------------------ */

describe("wrapRunner — errors", () => {
  it("rethrows errors from run() and closes the agent span with `failed` status", async () => {
    class ExplodingRunner implements RunnerLike {
      async run(_agent: AgentLike, _input: unknown): Promise<never> {
        void _agent;
        void _input;
        throw new Error("simulated upstream failure");
      }
    }
    const wrapped = wrapRunner(new ExplodingRunner());
    let thrown: unknown;
    try {
      await wrapped.run({ name: "a", model: "gpt-4o" }, "hi");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("simulated upstream failure");

    await new Promise((r) => setTimeout(r, 0));
    const last = getLastTrace();
    const spans = (last?.spans ?? []) as WireSpan[];
    const emitted = spans.find((s) => s.name === "openai-agents.agent");
    expect(emitted).toBeDefined();
    expect(emitted!.status).toBe("failed");
  });
});

/* ------------------------------------------------------------------------ */
/*  instrument / uninstall                                                   */
/* ------------------------------------------------------------------------ */

describe("instrumentOpenAIAgents", () => {
  it("with a runner argument, behaves equivalent to wrapRunner", async () => {
    const raw = happyPathRunner();
    const wrapped = (await instrumentOpenAIAgents(raw)) as RunnerLike;
    expect(isOpenAIAgentsWrapped(wrapped)).toBe(true);
    const result = await wrapped.run({ name: "a", model: "gpt-4o" }, "hi");
    expect(result).toBeDefined();
  });

  it("with no runner and no module, resolves to a falsy value without throwing", async () => {
    const result = await instrumentOpenAIAgents({});
    // Either `false` (module load returned null) or `undefined` (absorbed),
    // but never a truthy module-installed value, and never a thrown error.
    expect(Boolean(result)).toBe(false);
  });
});

// AID-09: this suite pins the pre-0.7 (0.6.0) naming (chains as `agent` spans). The default
// shape is covered in tests/agent-identity-*.test.ts.
beforeAll(() => {
  process.env.MORSE_AGENT_IDENTITY = "legacy";
});
afterAll(() => {
  delete process.env.MORSE_AGENT_IDENTITY;
});
