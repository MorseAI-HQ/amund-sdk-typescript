/**
 * End-to-end integration tests for the composed OpenAI Agents adapter
 * (`wrapRunnerWithFullInstrumentation`) — Phase 13 W3-O.
 *
 * Drives a single `FakeRunner` scripted with a non-trivial mix of llm /
 * tool / handoff / guardrail events through the full composed wrapper and
 * verifies the expected span tree lands on the active trace.
 *
 * The composed wrapper is the public 1-call entry point most adopters will
 * use; if any piece of the W2-O surface regresses, the assertion shape
 * here catches it before customers hit it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { wrapRunnerWithFullInstrumentation } from "../../../src/openai-agents";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";
import type { AgentLike, RunnerEventLike, RunnerLike } from "../../../src/openai-agents/types";

import { FakeRunner } from "./fixtures/fake-runner";

interface WireSpan {
  type: string;
  name: string;
  status?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Full-fan scripted runner: 2 llm + 2 tool + 1 handoff + 2 guardrails. */
function fullFanRunner(): FakeRunner {
  const events: RunnerEventLike[] = [
    { type: "llm_call_start", llm: { model: "gpt-4o", provider: "openai" } },
    {
      type: "llm_call_end",
      llm: {
        model: "gpt-4o",
        provider: "openai",
        usage: { input_tokens: 30, output_tokens: 15, total_tokens: 45 },
      },
    },
    {
      type: "tool_call_start",
      tool: { name: "search_flights", input: { city: "SF" } },
    },
    {
      type: "tool_call_end",
      tool: {
        name: "search_flights",
        output: { flights: 3 },
        duration_ms: 25,
        success: true,
      },
    },
    { type: "guardrail_check", guardrail: { name: "pii_filter", passed: true } },
    {
      type: "handoff",
      handoff: { from_agent: "triage_agent", to_agent: "booking_agent" },
    },
    { type: "llm_call_start", llm: { model: "gpt-4o", provider: "openai" } },
    {
      type: "llm_call_end",
      llm: {
        model: "gpt-4o",
        provider: "openai",
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
      },
    },
    {
      type: "tool_call_start",
      tool: { name: "book_seat", input: { seat: "12A" } },
    },
    {
      type: "tool_call_end",
      tool: {
        name: "book_seat",
        output: { booked: true },
        duration_ms: 18,
        success: true,
      },
    },
    {
      type: "guardrail_check",
      guardrail: { name: "pii_filter", passed: false, reason: "ssn detected" },
    },
  ];
  return new FakeRunner({
    events,
    result: { finalOutput: "booked seat 12A", newItems: [], usage: {} },
  });
}

/** Drain the wrapped runner inside a parent trace and return spans + result. */
async function runFullStackAndCapture(
  wrapped: RunnerLike,
  agent: AgentLike,
  input: unknown = "input",
): Promise<{ result: unknown; spans: WireSpan[] }> {
  let result: unknown;
  await runAsync({ agentName: "test-trace" }, async () => {
    result = await wrapped.run(agent, input);
  });
  await new Promise((r) => setTimeout(r, 0));
  const last = getLastTrace();
  const spans = ((last?.spans ?? []) as WireSpan[]).filter((s) => s.name !== "test-trace");
  return { result, spans };
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Composed wrapper — return shape                                          */
/* ------------------------------------------------------------------------ */

describe("wrapRunnerWithFullInstrumentation — return shape", () => {
  it("returns the wrapped runner and a dispose function", () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe("function");
    expect(typeof dispose).toBe("function");
    dispose();
  });

  it("the wrapped runner exposes `on` and `off` from the original runner", () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
    expect(typeof runner.on).toBe("function");
    expect(typeof runner.off).toBe("function");
    dispose();
  });
});

/* ------------------------------------------------------------------------ */
/*  End-to-end span tree                                                     */
/* ------------------------------------------------------------------------ */

describe("wrapRunnerWithFullInstrumentation — end-to-end span tree", () => {
  it("emits the full expected span tree for a 2 llm + 2 tool + 1 handoff + 2 guardrail run", async () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
    const agent: AgentLike = { name: "triage_agent", model: "gpt-4o" };

    const { spans } = await runFullStackAndCapture(runner, agent);
    dispose();

    // Outer agent span (one emitted; the test-trace root was filtered out).
    const agentSpans = spans.filter((s) => s.type === "agent");
    const outer = agentSpans.find((s) => s.name === "openai-agents.agent");
    expect(outer).toBeDefined();
    expect(outer!.metadata?.adapter).toBe("openai-agents");
    expect(outer!.metadata?.agent_name).toBe("triage_agent");

    // 2 llm spans.
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(2);

    // 2 regular tool spans (guardrails are type=tool but tagged tool_kind="guardrail").
    const toolSpans = spans.filter(
      (s) =>
        s.type === "tool" &&
        (s.metadata?.tool_kind === undefined || s.metadata?.tool_kind === "regular"),
    );
    expect(toolSpans).toHaveLength(2);

    // 1 handoff span (wire type=agent, metadata.spawn_kind="subagent").
    const handoffSpans = spans.filter(
      (s) => s.type === "agent" && s.metadata?.spawn_kind === "subagent",
    );
    expect(handoffSpans).toHaveLength(1);
    expect(handoffSpans[0]!.metadata?.parent_agent_name).toBe("triage_agent");
    expect(handoffSpans[0]!.metadata?.subagent_name).toBe("booking_agent");

    // 2 guardrail spans (wire type=tool, metadata.tool_kind="guardrail").
    const guardrailSpans = spans.filter(
      (s) => s.type === "tool" && s.metadata?.tool_kind === "guardrail",
    );
    expect(guardrailSpans).toHaveLength(2);
    const passed = guardrailSpans.find(
      (s) => (s.metadata?.guardrail as { passed?: boolean } | undefined)?.passed === true,
    );
    const failed = guardrailSpans.find(
      (s) => (s.metadata?.guardrail as { passed?: boolean } | undefined)?.passed === false,
    );
    expect(passed?.status).toBe("completed");
    expect(failed?.status).toBe("failed");

    // Totals: 1 outer + 2 llm + 2 tool + 1 handoff-subagent + 2 guardrails = 8.
    const composedSpans = spans.filter(
      (s) =>
        s.name === "openai-agents.agent" ||
        s.type === "llm" ||
        s.type === "tool" ||
        (s.type === "agent" && s.metadata?.spawn_kind === "subagent"),
    );
    expect(composedSpans).toHaveLength(8);
  });

  it("the outer agent span carries metadata.adapter === 'openai-agents'", async () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
    const { spans } = await runFullStackAndCapture(runner, {
      name: "triage_agent",
      model: "gpt-4o",
    });
    const outer = spans.find((s) => s.name === "openai-agents.agent");
    expect(outer!.metadata?.adapter).toBe("openai-agents");
    dispose();
  });

  it("returns the underlying FakeRunner result unchanged", async () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
    const { result } = await runFullStackAndCapture(runner, {
      name: "triage_agent",
      model: "gpt-4o",
    });
    expect(result).toBeDefined();
    expect((result as { finalOutput: string }).finalOutput).toBe("booked seat 12A");
    dispose();
  });

  it("llm spans carry token usage from the _end events", async () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
    const { spans } = await runFullStackAndCapture(runner, {
      name: "triage_agent",
      model: "gpt-4o",
    });
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(2);
    const totalInput = llmSpans.reduce((acc, s) => acc + (s.input_tokens ?? 0), 0);
    const totalOutput = llmSpans.reduce((acc, s) => acc + (s.output_tokens ?? 0), 0);
    expect(totalInput).toBe(50); // 30 + 20
    expect(totalOutput).toBe(23); // 15 + 8
    dispose();
  });
});

/* ------------------------------------------------------------------------ */
/*  Dispose                                                                  */
/* ------------------------------------------------------------------------ */

describe("wrapRunnerWithFullInstrumentation — dispose", () => {
  it("after dispose(), subsequent runner events do not produce inner spans", async () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);

    // First run — full instrumentation active.
    await runFullStackAndCapture(runner, {
      name: "triage_agent",
      model: "gpt-4o",
    });

    // Tear down all event listeners.
    dispose();

    // Second run on a freshly scripted runner with the same wrapped Proxy
    // attached to the *original* raw FakeRunner — but the listeners are
    // gone. We re-script the raw FakeRunner by replacing it; since the
    // wrapped Proxy forwards on/off to that runner, calling `runner.run`
    // again still goes through it. The agent span will still emit (it's
    // wired through patchedRun, not the event channel), but llm/tool/
    // handoff/guardrail spans must NOT emit.
    await runAsync({ agentName: "post-dispose" }, async () => {
      await runner.run({ name: "triage_agent", model: "gpt-4o" }, "input2");
    });
    await new Promise((r) => setTimeout(r, 0));
    const last = getLastTrace();
    const spans = ((last?.spans ?? []) as WireSpan[]).filter((s) => s.name !== "post-dispose");

    // The outer agent span (from wrapRunner) still emits — it's tied to
    // run() not the event channel.
    const outer = spans.find((s) => s.name === "openai-agents.agent");
    expect(outer).toBeDefined();

    // But none of the event-channel spans should appear.
    expect(spans.filter((s) => s.type === "llm")).toHaveLength(0);
    const inner = spans.filter(
      (s) => s.type === "tool" || (s.type === "agent" && s.metadata?.spawn_kind === "subagent"),
    );
    expect(inner).toHaveLength(0);
  });

  it("dispose() is idempotent and never throws", () => {
    const raw = fullFanRunner();
    const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
    expect(runner).toBeDefined();
    expect(() => {
      dispose();
      dispose();
      dispose();
    }).not.toThrow();
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
