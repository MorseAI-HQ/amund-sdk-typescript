/**
 * Tests for `anthropic-agent-sdk/llm-instrumentation.ts`.
 *
 * The wrapper is a passthrough generator that taps `message_start` /
 * `message_stop` pairs and emits one `llm` span per pair. We exercise it
 * against the shared `FakeClaudeSDKClient` fixture inside a trace driven
 * by `runAsync`, then inspect emitted spans via `getLastTrace()`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { instrumentLlmCalls } from "../../../src/anthropic-agent-sdk/llm-instrumentation";
import type {
  AnthropicMessageCreateParams,
  SDKMessageLike,
} from "../../../src/anthropic-agent-sdk/types";
import type { ContextSegment } from "../../../src/_internal/spans";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

import { FakeClaudeSDKClient } from "./fixtures/fake-claude-agent-sdk";

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------ */

interface WireSpan {
  type: string;
  name: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  context_segments?: ContextSegment[];
  status?: string;
  metadata?: Record<string, unknown>;
}

/** Drain an async iterable into an array. */
async function drain(events: AsyncIterable<SDKMessageLike>): Promise<SDKMessageLike[]> {
  const out: SDKMessageLike[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}

/** Returns all non-root spans captured in the last completed trace. */
function lastLlmSpans(): WireSpan[] {
  const last = getLastTrace();
  if (last === null) return [];
  return (last.spans as WireSpan[]).filter((s) => s.type === "llm");
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Tests                                                                    */
/* ------------------------------------------------------------------------ */

describe("instrumentLlmCalls", () => {
  it("emits exactly one llm span for a single message_start/stop pair", async () => {
    const client = new FakeClaudeSDKClient({ llmCallCount: 1 });
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(client.query("hi")));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("anthropic-agent-sdk.llm");
    expect(spans[0]!.model).toBe("claude-sonnet-4-5");
    expect(spans[0]!.metadata?.adapter).toBe("anthropic-agent-sdk");
  });

  it("emits N llm spans for N message_start/stop pairs", async () => {
    const client = new FakeClaudeSDKClient({ llmCallCount: 3 });
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(client.query("hi")));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(3);
    for (const s of spans) {
      expect(s.name).toBe("anthropic-agent-sdk.llm");
      expect(s.model).toBe("claude-sonnet-4-5");
    }
  });

  it("hydrates output_tokens from message.usage on message_stop", async () => {
    const client = new FakeClaudeSDKClient({
      llmCallCount: 1,
      usagePerCall: { input_tokens: 100, output_tokens: 42 },
    });
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(client.query("hi")));
    });
    const spans = lastLlmSpans();
    expect(spans[0]!.output_tokens).toBe(42);
    expect(spans[0]!.input_tokens).toBe(100);
    expect(spans[0]!.total_tokens).toBe(142);
  });

  it("sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "message_start",
        message: { id: "m1", model: "claude-sonnet-4-5", usage: { input_tokens: 10 } },
      };
      yield {
        type: "message_stop",
        message: {
          id: "m1",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 50,
            output_tokens: 7,
          },
        },
      };
    }
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(gen()));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.input_tokens).toBe(260); // 10 + 200 + 50
    expect(spans[0]!.output_tokens).toBe(7);
    expect(spans[0]!.total_tokens).toBe(267);
  });

  it("populates context_segments when requestParams is provided", async () => {
    const client = new FakeClaudeSDKClient({ llmCallCount: 1 });
    const requestParams: AnthropicMessageCreateParams = {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: "You are a helpful agent.",
      messages: [{ role: "user", content: "What is 2+2?" }],
    };
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(client.query("hi"), { requestParams }));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(1);
    expect(Array.isArray(spans[0]!.context_segments)).toBe(true);
    expect(spans[0]!.context_segments!.length).toBeGreaterThan(0);
    // Should contain system_prompt + current_input segments at minimum.
    const sources = spans[0]!.context_segments!.map((s) => s.source);
    expect(sources).toContain("system_prompt");
    expect(sources).toContain("current_input");
  });

  it("leaves context_segments undefined when no requestParams is provided", async () => {
    const client = new FakeClaudeSDKClient({ llmCallCount: 1 });
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(client.query("hi")));
    });
    const spans = lastLlmSpans();
    expect(spans[0]!.context_segments).toBeUndefined();
  });

  it("yields every event through unchanged (pure passthrough)", async () => {
    const client = new FakeClaudeSDKClient({
      llmCallCount: 2,
      tools: [{ name: "web_search", input: { q: "x" }, output: "y" }],
    });
    // Capture the raw stream by running the fixture twice with identical script.
    const rawClient = new FakeClaudeSDKClient({
      llmCallCount: 2,
      tools: [{ name: "web_search", input: { q: "x" }, output: "y" }],
    });
    const raw = await drain(rawClient.query("hi"));
    let wrapped: SDKMessageLike[] = [];
    await runAsync({ agentName: "t" }, async () => {
      wrapped = await drain(instrumentLlmCalls(client.query("hi")));
    });
    expect(wrapped).toHaveLength(raw.length);
    for (let i = 0; i < raw.length; i++) {
      expect(wrapped[i]!.type).toBe(raw[i]!.type);
    }
  });

  it("uses fallbackModel when message.model is absent", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "message_start",
        message: { id: "m1", usage: { input_tokens: 1 } },
      };
      yield {
        type: "message_stop",
        message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } },
      };
    }
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(gen(), { fallbackModel: "claude-fallback-x" }));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.model).toBe("claude-fallback-x");
  });

  it("tolerates an orphan message_stop with no preceding message_start", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "message_stop",
        message: { id: "orphan", usage: { output_tokens: 5 } },
      };
    }
    let collected: SDKMessageLike[] = [];
    await runAsync({ agentName: "t" }, async () => {
      // Must not throw.
      collected = await drain(instrumentLlmCalls(gen()));
    });
    expect(collected).toHaveLength(1);
    expect(lastLlmSpans()).toHaveLength(0);
  });

  it("closes an open span as failed when the iterator ends before message_stop", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "message_start",
        message: { id: "m1", model: "claude-sonnet-4-5", usage: { input_tokens: 1 } },
      };
      // No message_stop.
    }
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(gen()));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
  });

  it("does not propagate errors thrown by extractAnthropicSegments", async () => {
    // Supply a pathological requestParams that causes extractAnthropicSegments
    // to hit edge cases — but more importantly, even if it threw, the wrapper
    // must absorb. We construct a Proxy that throws on any property read of
    // `messages` to force a failure path.
    const evilParams = new Proxy({} as AnthropicMessageCreateParams, {
      get(_t, prop) {
        if (prop === "messages") {
          throw new Error("boom from messages getter");
        }
        if (prop === "tools" || prop === "system") return undefined;
        return undefined;
      },
    });
    const client = new FakeClaudeSDKClient({ llmCallCount: 1 });
    let threw = false;
    await runAsync({ agentName: "t" }, async () => {
      try {
        await drain(instrumentLlmCalls(client.query("hi"), { requestParams: evilParams }));
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
    // Span should still have been emitted (segment extraction failure is absorbed).
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.context_segments).toBeUndefined();
  });

  it("emits one llm span per pair across an agent-loop fixture with tools in between", async () => {
    const client = new FakeClaudeSDKClient({
      llmCallCount: 2,
      tools: [{ name: "web_search", input: { q: "x" }, output: "y" }],
    });
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(client.query("hi")));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(2);
  });

  it("emits no llm span when no message_start/stop events occur", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      yield { type: "tool_use", tool_use_id: "t1", name: "x", input: {} };
      yield { type: "tool_result", tool_use_id: "t1", content: "ok" };
    }
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(gen()));
    });
    expect(lastLlmSpans()).toHaveLength(0);
  });

  /* -- Real Claude Agent SDK shape (assistant events) — added 2026-05-27 -- */

  it("emits an llm span for a real-shape `assistant` event", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "system",
        // surplus init fields; ignored
      } as SDKMessageLike;
      yield {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 0,
            output_tokens: 3,
          },
        },
      } as SDKMessageLike;
      yield { type: "result", subtype: "success" } as SDKMessageLike;
    }
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(gen()));
    });
    const spans = lastLlmSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.model).toBe("claude-haiku-4-5-20251001");
    // Real-shape usage on assistant event is complete (not partial like message_start).
    expect(spans[0]!.input_tokens).toBe(15); // 5 + 10 + 0
    expect(spans[0]!.output_tokens).toBe(3);
    expect(spans[0]!.total_tokens).toBe(18);
  });

  it("emits one llm span per assistant event when the agent loops", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      for (let i = 0; i < 3; i++) {
        yield {
          type: "assistant",
          message: {
            id: `msg_${i}`,
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "step" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        } as SDKMessageLike;
      }
    }
    await runAsync({ agentName: "t" }, async () => {
      await drain(instrumentLlmCalls(gen()));
    });
    expect(lastLlmSpans()).toHaveLength(3);
  });
});
