/**
 * Tests for `openai-agents/handoff.ts` — handoff-span instrumentation.
 *
 * The fake runner from `fixtures/fake-runner.ts` fires the canonical
 * `handoff` event during `runner.run()`. We wrap that call inside
 * `runAsync` so the emitted spans land in an active trace; once
 * `runAsync` finalises, the resulting spans are inspected via
 * `getLastTrace()`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeRunner, handoffRunner } from "./fixtures/fake-runner";
import { installHandoffInstrumentation } from "../../../src/openai-agents/handoff";
import type { AgentLike, RunnerEventLike } from "../../../src/openai-agents/types";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

interface WireSpan {
  type: string;
  name: string;
  status?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

const AGENT: AgentLike = { name: "triage_agent", model: "gpt-4o" };

async function collectChildSpans(driver: () => Promise<void> | void): Promise<WireSpan[]> {
  await runAsync({ agentName: "root" }, async () => {
    await driver();
  });
  const last = getLastTrace();
  if (last === null) return [];
  return (last.spans as WireSpan[]).filter((s) => s.name !== "root");
}

/** MHQ-1025: one handoff event now emits a `handoff` span AND a subagent span. */
const byType = (spans: WireSpan[], type: string): WireSpan[] =>
  spans.filter((s) => s.type === type);

beforeEach(() => {
  _resetForTesting();
});

describe("installHandoffInstrumentation", () => {
  it("emits a native type=handoff span plus the subagent span on a handoff event", async () => {
    const runner = handoffRunner();
    const spans = await collectChildSpans(async () => {
      installHandoffInstrumentation(runner);
      await runner.run(AGENT, "book me a window seat");
    });
    // happyPath events emit no spans here; only the handoff event does.
    expect(spans).toHaveLength(2);

    // MHQ-1025: the routing decision is its own navigable, timestamped node.
    const handoff = byType(spans, "handoff")[0]!;
    expect(handoff.name).toBe("triage_agent → seat_booking_agent");
    expect(handoff.metadata?.from_agent).toBe("triage_agent");
    expect(handoff.metadata?.to_agent).toBe("seat_booking_agent");
    expect(handoff.metadata?.adapter).toBe("openai-agents");
    // It is emitted before the target agent span, so the tree reads in order.
    expect(spans[0]!.type).toBe("handoff");

    const subagent = byType(spans, "agent")[0]!;
    expect(subagent.metadata?.spawn_kind).toBe("subagent");
    expect(subagent.metadata?.adapter).toBe("openai-agents");
  });

  it("propagates handoff_from + subagent_name into span metadata", async () => {
    const runner = handoffRunner();
    const spans = await collectChildSpans(async () => {
      installHandoffInstrumentation(runner);
      await runner.run(AGENT, "x");
    });
    const span = byType(spans, "agent")[0]!;
    // The key the server reads to derive HANDS_OFF_TO rather than SPAWNS.
    expect(span.metadata?.askl_handoff_from).toBe("triage_agent");
    expect(span.metadata?.handoff_from).toBe("triage_agent");
    expect(span.metadata?.parent_agent_name).toBe("triage_agent");
    expect(span.metadata?.subagent_name).toBe("seat_booking_agent");
    expect(span.name).toBe("openai-agents.subagent.seat_booking_agent");
  });

  it("propagates handoff.reason into task_description + handoff_reason when present", async () => {
    const runner = new FakeRunner({
      events: [
        {
          type: "handoff",
          handoff: {
            from_agent: "triage_agent",
            to_agent: "refund_agent",
            reason: "user requested a refund",
          },
        },
      ],
    });
    const spans = await collectChildSpans(async () => {
      installHandoffInstrumentation(runner);
      await runner.run(AGENT, "x");
    });
    const span = byType(spans, "agent")[0]!;
    expect(span.metadata?.task_description).toBe("user requested a refund");
    expect(span.metadata?.handoff_reason).toBe("user requested a refund");
    // The reason also rides the handoff span itself.
    expect(byType(spans, "handoff")[0]!.metadata?.handoff_reason).toBe("user requested a refund");
  });

  it("emits one span pair per handoff event when multiple are fired", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "handoff", handoff: { from_agent: "triage_agent", to_agent: "seat_agent" } },
        { type: "handoff", handoff: { from_agent: "seat_agent", to_agent: "payment_agent" } },
        { type: "handoff", handoff: { from_agent: "payment_agent", to_agent: "confirm_agent" } },
      ],
    });
    const spans = await collectChildSpans(async () => {
      installHandoffInstrumentation(runner);
      await runner.run(AGENT, "x");
    });
    expect(spans).toHaveLength(6);
    expect(byType(spans, "agent").map((s) => s.metadata?.subagent_name)).toEqual([
      "seat_agent",
      "payment_agent",
      "confirm_agent",
    ]);
    // The chain is readable from the handoff spans alone.
    expect(byType(spans, "handoff").map((s) => s.name)).toEqual([
      "triage_agent → seat_agent",
      "seat_agent → payment_agent",
      "payment_agent → confirm_agent",
    ]);
  });

  it("emits no span (and does not throw) when from_agent or to_agent is missing", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "handoff", handoff: { to_agent: "seat_agent" } },
        { type: "handoff", handoff: { from_agent: "triage_agent" } },
        { type: "handoff", handoff: {} },
        { type: "handoff" }, // no handoff payload at all
      ],
    });
    const spans = await collectChildSpans(async () => {
      installHandoffInstrumentation(runner);
      await runner.run(AGENT, "x");
    });
    expect(spans).toHaveLength(0);
  });

  it("no-ops without throwing when the runner has no .on method", () => {
    const runner = { run: async () => ({ finalOutput: "ok" }) } as unknown as Parameters<
      typeof installHandoffInstrumentation
    >[0];
    const unsubscribe = installHandoffInstrumentation(runner);
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("returned unsubscribe stops future handoff emissions", async () => {
    const runner = handoffRunner();
    const offSpy = vi.spyOn(runner, "off");
    const spans = await collectChildSpans(async () => {
      const unsubscribe = installHandoffInstrumentation(runner);
      unsubscribe();
      await runner.run(AGENT, "x");
    });
    expect(offSpy).toHaveBeenCalledWith("handoff", expect.any(Function));
    expect(spans).toHaveLength(0);
  });

  it("closes both spans immediately (status=completed, duration_ms near 0)", async () => {
    const runner = handoffRunner();
    const spans = await collectChildSpans(async () => {
      installHandoffInstrumentation(runner);
      await runner.run(AGENT, "x");
    });
    for (const span of spans) {
      expect(span.status).toBe("completed");
      expect(typeof span.ended_at).toBe("string");
      expect(typeof span.duration_ms).toBe("number");
      expect(span.duration_ms).toBeGreaterThanOrEqual(0);
      expect(span.duration_ms).toBeLessThan(50);
    }
  });

  it("does not throw when the handoff event payload is not a plain object", async () => {
    const runner = new FakeRunner({
      events: [
        // Cast through unknown so this exercises the runtime guard, not the type checker.
        { type: "handoff", handoff: "garbage" as unknown as RunnerEventLike["handoff"] },
      ],
    });
    const spans = await collectChildSpans(async () => {
      installHandoffInstrumentation(runner);
      await runner.run(AGENT, "x");
    });
    expect(spans).toHaveLength(0);
  });
});
