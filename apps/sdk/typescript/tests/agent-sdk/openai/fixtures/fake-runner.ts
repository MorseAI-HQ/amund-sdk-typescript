/**
 * Fake OpenAI Agents `Runner` for unit tests across Wave 2-O subagent tasks.
 *
 * Drives the same event sequence the real `@openai/agents` Runner emits:
 *   agent_start → (llm_call_start/end | tool_call_start/end | handoff |
 *   guardrail_check)* → agent_end
 *
 * Used by:
 *   - tests/agent-sdk/openai/runner-wrapper.test.ts
 *   - tests/agent-sdk/openai/llm-and-tool.test.ts
 *   - tests/agent-sdk/openai/handoff.test.ts
 *   - tests/agent-sdk/openai/guardrail.test.ts
 *   - tests/agent-sdk/openai/integration.test.ts
 */

import type {
  AgentLike,
  RunResultLike,
  RunnerEventLike,
  RunnerLike,
} from "../../../../src/openai-agents/types";

export interface FakeRunnerScript {
  /** Sequence of events to emit between agent_start and agent_end. */
  events?: RunnerEventLike[];
  /** Final result payload. */
  result?: RunResultLike;
}

export class FakeRunner implements RunnerLike {
  private readonly script: FakeRunnerScript;
  private readonly listeners = new Map<string, Set<(p: RunnerEventLike) => void>>();

  constructor(script: FakeRunnerScript = {}) {
    this.script = script;
  }

  on(event: string, handler: (payload: RunnerEventLike) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: (payload: RunnerEventLike) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  private fire(payload: RunnerEventLike): void {
    // Fire on both the typed channel ("agent_start") and the catch-all ("event")
    // because both shapes exist in the real SDK.
    for (const h of this.listeners.get(payload.type) ?? []) h(payload);
    for (const h of this.listeners.get("event") ?? []) h(payload);
  }

  async run(
    agent: AgentLike,
    input: unknown,
    options?: Record<string, unknown>,
  ): Promise<RunResultLike> {
    void input;
    void options;
    this.fire({
      type: "agent_start",
      agent: { name: agent.name, model: stringifyModel(agent.model) },
    });
    for (const evt of this.script.events ?? []) {
      this.fire(evt);
    }
    this.fire({ type: "agent_end", agent: { name: agent.name } });
    return this.script.result ?? { finalOutput: "ok", newItems: [], usage: {} };
  }
}

function stringifyModel(m: AgentLike["model"]): string | undefined {
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof m.id === "string") return m.id;
  return undefined;
}

/** Canonical happy-path fixture: one llm call, one tool call. */
export function happyPathRunner(): FakeRunner {
  return new FakeRunner({
    events: [
      {
        type: "llm_call_start",
        llm: { model: "gpt-4o", provider: "openai" },
      },
      {
        type: "llm_call_end",
        llm: {
          model: "gpt-4o",
          provider: "openai",
          usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
        },
      },
      { type: "tool_call_start", tool: { name: "get_weather", input: { city: "SF" } } },
      {
        type: "tool_call_end",
        tool: { name: "get_weather", output: { temp: 65 }, duration_ms: 12, success: true },
      },
    ],
  });
}

/** Fan-out fixture: handoff from triage → seat_booking. */
export function handoffRunner(): FakeRunner {
  return new FakeRunner({
    events: [
      { type: "llm_call_start", llm: { model: "gpt-4o", provider: "openai" } },
      {
        type: "llm_call_end",
        llm: {
          model: "gpt-4o",
          provider: "openai",
          usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
        },
      },
      {
        type: "handoff",
        handoff: { from_agent: "triage_agent", to_agent: "seat_booking_agent" },
      },
    ],
  });
}

/** Guardrail fixture: one pass, one fail. */
export function guardrailRunner(): FakeRunner {
  return new FakeRunner({
    events: [
      {
        type: "guardrail_check",
        guardrail: { name: "pii_filter", passed: true },
      },
      {
        type: "guardrail_check",
        guardrail: { name: "pii_filter", passed: false, reason: "ssn detected" },
      },
    ],
  });
}
