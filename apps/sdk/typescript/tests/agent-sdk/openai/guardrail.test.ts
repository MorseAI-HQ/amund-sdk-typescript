/**
 * Tests for `openai-agents/guardrail.ts` (W2-O.4).
 *
 * Drives the `FakeRunner` (which exposes `runner.on("guardrail_check", ...)`)
 * and asserts that emitted guardrail spans:
 *
 *   - carry `metadata.tool_kind="guardrail"` and `metadata.guardrail.{...}`
 *   - close with `completed` status on pass, `failed` on fail
 *   - propagate `name` and (when present) `reason`
 *   - fall back to anonymous name when no `guardrail.name` is present
 *   - stop emitting after the returned unsubscribe is called
 *   - no-op when the runner has no `on` method
 *
 * Trace state is established via `runAsync` so `startSpan` has somewhere to
 * push the spans. Inspection uses `getLastTrace()` for completed spans.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { installGuardrailInstrumentation } from "../../../src/openai-agents/guardrail";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";
import { FakeRunner, guardrailRunner } from "./fixtures/fake-runner";
import type { AgentLike } from "../../../src/openai-agents/types";

interface WireSpan {
  span_id: string;
  parent_span_id?: string;
  name: string;
  type: string;
  status?: string;
  error_message?: string;
  metadata?: Record<string, unknown> & {
    tool_kind?: string;
    guardrail?: { name?: string; passed?: boolean; reason?: string };
  };
}

const AGENT: AgentLike = { name: "triage_agent", model: "gpt-4o" };

/**
 * Run the fake runner inside a fresh trace and return all emitted spans
 * (minus the synthetic root agent span used to seat the trace).
 */
async function collectSpans(runner: FakeRunner): Promise<WireSpan[]> {
  await runAsync({ agentName: "test-agent" }, async () => {
    installGuardrailInstrumentation(runner);
    await runner.run(AGENT, "prompt");
  });
  const last = getLastTrace();
  if (last === null) return [];
  return (last.spans as WireSpan[]).filter((s) => s.name !== "test-agent");
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Installer guardrails                                                     */
/* ------------------------------------------------------------------------ */

describe("installGuardrailInstrumentation — installer guardrails", () => {
  it("returns a no-op unsubscriber when runner.on is not a function", () => {
    const fakeRunner = {
      run: async () => ({ finalOutput: "" }),
    } as unknown as Parameters<typeof installGuardrailInstrumentation>[0];
    const unsub = installGuardrailInstrumentation(fakeRunner);
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });

  it("does not throw when runner is missing required surface entirely", () => {
    const fakeRunner = {} as unknown as Parameters<typeof installGuardrailInstrumentation>[0];
    expect(() => installGuardrailInstrumentation(fakeRunner)()).not.toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/*  Pass / fail emission                                                     */
/* ------------------------------------------------------------------------ */

describe("installGuardrailInstrumentation — pass/fail emission", () => {
  it("emits one completed span per passing guardrail check", async () => {
    const runner = new FakeRunner({
      events: [
        {
          type: "guardrail_check",
          guardrail: { name: "pii_filter", passed: true },
        },
      ],
    });
    const spans = (await collectSpans(runner)).filter((s) => s.metadata?.tool_kind === "guardrail");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("completed");
    expect(spans[0]!.metadata?.guardrail?.passed).toBe(true);
    expect(spans[0]!.error_message).toBeUndefined();
  });

  it("emits a failed span when guardrail.passed is false, with reason in metadata", async () => {
    const runner = new FakeRunner({
      events: [
        {
          type: "guardrail_check",
          guardrail: { name: "pii_filter", passed: false, reason: "ssn detected" },
        },
      ],
    });
    const spans = (await collectSpans(runner)).filter((s) => s.metadata?.tool_kind === "guardrail");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
    expect(spans[0]!.metadata?.guardrail?.passed).toBe(false);
    expect(spans[0]!.metadata?.guardrail?.reason).toBe("ssn detected");
    expect(spans[0]!.error_message).toContain("ssn detected");
  });

  it("tags wire type=tool and metadata.tool_kind=guardrail", async () => {
    const runner = new FakeRunner({
      events: [
        {
          type: "guardrail_check",
          guardrail: { name: "rate_limit", passed: true },
        },
      ],
    });
    const spans = (await collectSpans(runner)).filter((s) => s.metadata?.tool_kind === "guardrail");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.type).toBe("tool");
    expect(spans[0]!.metadata?.tool_kind).toBe("guardrail");
  });

  it("propagates guardrail.name into metadata when present", async () => {
    const runner = new FakeRunner({
      events: [
        {
          type: "guardrail_check",
          guardrail: { name: "jailbreak_detector", passed: true },
        },
      ],
    });
    const spans = (await collectSpans(runner)).filter((s) => s.metadata?.tool_kind === "guardrail");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.metadata?.guardrail?.name).toBe("jailbreak_detector");
    expect(spans[0]!.name).toBe("openai-agents.tool.guardrail.jailbreak_detector");
  });
});

/* ------------------------------------------------------------------------ */
/*  Multi-event + anonymous + canonical fixture                              */
/* ------------------------------------------------------------------------ */

describe("installGuardrailInstrumentation — multi + anonymous", () => {
  it("emits a span per event when multiple guardrails fire", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "guardrail_check", guardrail: { name: "g1", passed: true } },
        { type: "guardrail_check", guardrail: { name: "g2", passed: true } },
        { type: "guardrail_check", guardrail: { name: "g3", passed: false, reason: "x" } },
      ],
    });
    const spans = (await collectSpans(runner)).filter((s) => s.metadata?.tool_kind === "guardrail");
    expect(spans).toHaveLength(3);
    const names = spans.map((s) => s.metadata?.guardrail?.name).sort();
    expect(names).toEqual(["g1", "g2", "g3"]);
    const failed = spans.filter((s) => s.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.metadata?.guardrail?.name).toBe("g3");
  });

  it("falls back to anonymous name when guardrail.name is absent", async () => {
    const runner = new FakeRunner({
      events: [
        {
          type: "guardrail_check",
          guardrail: { passed: true },
        },
      ],
    });
    const spans = (await collectSpans(runner)).filter((s) => s.metadata?.tool_kind === "guardrail");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("openai-agents.tool.guardrail.anon");
    expect(spans[0]!.status).toBe("completed");
    expect(spans[0]!.metadata?.guardrail?.name).toBeUndefined();
    expect(spans[0]!.metadata?.guardrail?.passed).toBe(true);
  });

  it("works with the canonical guardrailRunner() fixture (one pass + one fail)", async () => {
    const spans = (await collectSpans(guardrailRunner())).filter(
      (s) => s.metadata?.tool_kind === "guardrail",
    );
    expect(spans).toHaveLength(2);
    const passed = spans.find((s) => s.metadata?.guardrail?.passed === true);
    const failed = spans.find((s) => s.metadata?.guardrail?.passed === false);
    expect(passed).toBeDefined();
    expect(failed).toBeDefined();
    expect(passed!.status).toBe("completed");
    expect(failed!.status).toBe("failed");
    expect(failed!.metadata?.guardrail?.reason).toBe("ssn detected");
  });
});

/* ------------------------------------------------------------------------ */
/*  Unsubscribe                                                              */
/* ------------------------------------------------------------------------ */

describe("installGuardrailInstrumentation — unsubscribe", () => {
  it("stops emitting future spans after the returned unsubscribe is called", async () => {
    const runner = new FakeRunner({
      events: [{ type: "guardrail_check", guardrail: { name: "g_after", passed: true } }],
    });

    await runAsync({ agentName: "test-agent" }, async () => {
      const unsub = installGuardrailInstrumentation(runner);
      unsub();
      await runner.run(AGENT, "prompt");
    });

    const last = getLastTrace();
    const all = (last?.spans ?? []) as WireSpan[];
    const guardrailSpans = all.filter((s) => s.metadata?.tool_kind === "guardrail");
    expect(guardrailSpans).toHaveLength(0);
  });
});
