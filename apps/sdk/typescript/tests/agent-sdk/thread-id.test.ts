/**
 * MHQ-1029 — adapters must carry conversation identity onto the trace.
 *
 * The TypeScript half of MHQ-1022, which found this in the Python SDK: every
 * trace landed with `thread_id: null`, so a five-turn conversation showed up
 * as five unrelated traces with nothing linking them. `_internal/tracing.ts`
 * had supported `threadId` since MHQ-748; no adapter ever set it.
 *
 * Extraction is per-framework (a `session`, a run context, a LangGraph
 * `configurable.thread_id`); the write is shared — `adoptThreadId`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { MorseCallbackHandler } from "../../src/langgraph/callback-handler";
import { wrapRunner } from "../../src/openai-agents/runner-wrapper";
import type { AgentLike } from "../../src/openai-agents/types";
import {
  _resetForTesting,
  adoptThreadId,
  getLastTrace,
  runAsync,
} from "../../src/_internal/tracing";

import { FakeRunner } from "./openai/fixtures/fake-runner";

const AGENT: AgentLike = { name: "TriageAgent" };

/** ChatKit's `AgentContext` shape — the thread lives at `.thread.id`. */
function chatkitContext(threadId: string): Record<string, unknown> {
  return { thread: { id: threadId } };
}

/** Drain one wrapped `run()` and return the emitted trace's `thread_id`. */
async function runAndGetThreadId(callOptions?: Record<string, unknown>): Promise<unknown> {
  const runner = wrapRunner(new FakeRunner());
  await runner.run(AGENT, "hi", callOptions);
  await new Promise((r) => setTimeout(r, 0));
  return (getLastTrace()?.trace as { thread_id?: unknown } | undefined)?.thread_id;
}

beforeEach(() => {
  _resetForTesting();
});

describe("openai-agents — thread_id (MHQ-1029)", () => {
  it("takes the ChatKit thread off the run context", async () => {
    expect(await runAndGetThreadId({ context: chatkitContext("thr_d2f4ef47") })).toBe(
      "thr_d2f4ef47",
    );
  });

  it("five turns on one thread share a thread_id but stay separate traces", async () => {
    const context = chatkitContext("thr_d2f4ef47");
    const threads = new Set<unknown>();
    const traces = new Set<unknown>();
    for (let i = 0; i < 5; i++) {
      const runner = wrapRunner(new FakeRunner());
      await runner.run(AGENT, `turn ${i}`, { context });
      await new Promise((r) => setTimeout(r, 0));
      const trace = getLastTrace()?.trace as { thread_id?: unknown; trace_id?: unknown };
      threads.add(trace?.thread_id);
      traces.add(trace?.trace_id);
    }
    expect([...threads]).toEqual(["thr_d2f4ef47"]);
    expect(traces.size).toBe(5);
  });

  it("prefers `session` over the run context", async () => {
    const threadId = await runAndGetThreadId({
      session: { sessionId: "sess-42" },
      context: chatkitContext("thr_ignored"),
    });
    expect(threadId).toBe("sess-42");
  });

  it("uses `conversationId` when there is no session", async () => {
    expect(await runAndGetThreadId({ conversationId: "conv_9" })).toBe("conv_9");
  });

  it("reads a plain `threadId` off a hand-rolled context", async () => {
    expect(await runAndGetThreadId({ context: { threadId: "my-thread" } })).toBe("my-thread");
  });

  it("leaves it unset when the run carries no conversation signal", async () => {
    // Absence is the signal — never invent an id for a one-shot run.
    expect(await runAndGetThreadId()).toBeUndefined();
    expect(await runAndGetThreadId({ context: {} })).toBeUndefined();
  });

  it("survives a context whose getter throws", async () => {
    const context = {
      get threadId(): string {
        throw new Error("customer code");
      },
    };
    expect(await runAndGetThreadId({ context })).toBeUndefined();
  });
});

describe("langgraph — thread_id (MHQ-1029)", () => {
  it("takes `configurable.thread_id` off the run metadata", async () => {
    const handler = new MorseCallbackHandler();
    await runAsync({ agentName: "chat-agent" }, async () => {
      handler.handleChainStart({ name: "LangGraph" }, {}, "run-1", undefined, undefined, {
        thread_id: "conv-77",
        langgraph_step: 1,
      });
      handler.handleChainEnd({}, "run-1");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect((getLastTrace()?.trace as { thread_id?: unknown }).thread_id).toBe("conv-77");
  });
});

describe("adoptThreadId", () => {
  it("never overwrites an explicit run({ threadId })", async () => {
    await runAsync({ agentName: "chat-agent", threadId: "app-owned" }, async () => {
      adoptThreadId("adapter-guess");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect((getLastTrace()?.trace as { thread_id?: unknown }).thread_id).toBe("app-owned");
  });

  it("is a no-op outside an active trace", () => {
    expect(() => {
      adoptThreadId("thr_orphan");
    }).not.toThrow();
  });

  it("survives a value whose toString throws", async () => {
    const hostile = {
      toString(): string {
        throw new Error("boom");
      },
    };
    await runAsync({ agentName: "chat-agent" }, async () => {
      adoptThreadId(hostile);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect((getLastTrace()?.trace as { thread_id?: unknown }).thread_id).toBeUndefined();
  });
});
