/**
 * Tests for `langgraph/streaming-and-checkpoint.ts` — Phase 13 W2-L.3.
 *
 * Streaming-token aggregation: assert that `handleLLMNewToken` increments
 * a single counter on the parent llm span instead of emitting one span
 * per token. Also covers no-op behaviour when no matching llm span is
 * registered and when `trackStreamingTokens` is disabled.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  createStreamingHandlers,
  type StreamingState,
} from "../../../src/langgraph/streaming-and-checkpoint";
import {
  _resetForTesting,
  getLastTrace,
  runAsync,
  startSpan,
  type SpanHandle,
} from "../../../src/_internal/tracing";
import { replayStreamingTokens } from "./fixtures/fake-callback-events";

interface WireSpan {
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function freshState(): StreamingState {
  return { llmSpans: new Map<string, SpanHandle>() };
}

beforeEach(() => {
  _resetForTesting();
});

describe("createStreamingHandlers", () => {
  it("returns an object exposing handleLLMNewToken", () => {
    const handlers = createStreamingHandlers(freshState());
    expect(typeof handlers.handleLLMNewToken).toBe("function");
  });

  it("aggregates 500 streaming tokens onto the parent llm span (no per-token spans)", async () => {
    const state = freshState();
    const handlers = createStreamingHandlers(state);
    const runId = "llm_run_500";

    await runAsync({ agentName: "stream-test" }, async () => {
      const handle = startSpan({ name: "fake-llm", type: "llm" });
      expect(handle).not.toBeNull();
      state.llmSpans.set(runId, handle!);
      for (let i = 0; i < 500; i++) {
        await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: i }, runId);
      }
      handle!.end();
    });

    const last = getLastTrace();
    expect(last).not.toBeNull();
    const spans = (last!.spans as WireSpan[]).filter((s) => s.name !== "stream-test");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.type).toBe("llm");
    expect(spans[0]!.metadata?.tokens_streamed).toBe(500);
  });

  it("is a no-op when no llm span is registered for the runId", async () => {
    const state = freshState();
    const handlers = createStreamingHandlers(state);

    await runAsync({ agentName: "no-llm-trace" }, async () => {
      // Stream tokens against an unknown runId — should silently drop.
      for (let i = 0; i < 5; i++) {
        await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: i }, "unknown_run");
      }
    });

    const last = getLastTrace();
    expect(last).not.toBeNull();
    const spans = (last!.spans as WireSpan[]).filter((s) => s.name !== "no-llm-trace");
    expect(spans).toHaveLength(0);
  });

  it("does not throw when invoked with no active trace and no registered span", () => {
    const state = freshState();
    const handlers = createStreamingHandlers(state);
    // Outside any runAsync — must not throw.
    expect(() =>
      handlers.handleLLMNewToken!("tok", { prompt: 0, completion: 0 }, "missing"),
    ).not.toThrow();
  });

  it("is a no-op when trackStreamingTokens=false, even with span registered", async () => {
    const state = freshState();
    const handlers = createStreamingHandlers(state, { trackStreamingTokens: false });
    const runId = "llm_run_off";

    await runAsync({ agentName: "off-test" }, async () => {
      const handle = startSpan({ name: "fake-llm", type: "llm" });
      state.llmSpans.set(runId, handle!);
      for (let i = 0; i < 10; i++) {
        await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: i }, runId);
      }
      handle!.end();
    });

    const last = getLastTrace();
    const spans = (last!.spans as WireSpan[]).filter((s) => s.name !== "off-test");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.metadata?.tokens_streamed).toBeUndefined();
  });

  it("tracks independent token counts for two different runIds", async () => {
    const state = freshState();
    const handlers = createStreamingHandlers(state);
    const runA = "run_a";
    const runB = "run_b";

    await runAsync({ agentName: "multi-run" }, async () => {
      const handleA = startSpan({ name: "llm-a", type: "llm" });
      const handleB = startSpan({ name: "llm-b", type: "llm" });
      state.llmSpans.set(runA, handleA!);
      state.llmSpans.set(runB, handleB!);

      for (let i = 0; i < 7; i++) {
        await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: i }, runA);
      }
      for (let i = 0; i < 3; i++) {
        await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: i }, runB);
      }

      handleB!.end();
      handleA!.end();
    });

    const last = getLastTrace();
    const spans = (last!.spans as WireSpan[]).filter((s) => s.type === "llm");
    expect(spans).toHaveLength(2);
    const a = spans.find((s) => s.name === "llm-a")!;
    const b = spans.find((s) => s.name === "llm-b")!;
    expect(a.metadata?.tokens_streamed).toBe(7);
    expect(b.metadata?.tokens_streamed).toBe(3);
  });

  it("replayStreamingTokens(handler, 10) end-to-end yields one llm span with tokens_streamed=10", async () => {
    const state = freshState();
    const streamingHandlers = createStreamingHandlers(state);

    // The fixture replays chainStart → llmStart → 10×newToken → llmEnd →
    // chainEnd. Since we are only implementing the streaming handler in
    // this wave, we register the llm span ourselves on `handleLLMStart`
    // and drop it on `handleLLMEnd` — mirroring what W2-L.2 will do.
    const llmRunId = "llm_stream";
    let llmHandle: SpanHandle | null = null;

    const composedHandler = {
      handleChainStart: async () => {
        /* no-op */
      },
      handleLLMStart: async (_llm: unknown, _prompts: string[], runId: string): Promise<void> => {
        llmHandle = startSpan({ name: "fake-llm-stream", type: "llm" });
        if (llmHandle) state.llmSpans.set(runId, llmHandle);
      },
      handleLLMNewToken: streamingHandlers.handleLLMNewToken,
      handleLLMEnd: async (_out: unknown, runId: string): Promise<void> => {
        const h = state.llmSpans.get(runId);
        if (h) {
          h.end();
          state.llmSpans.delete(runId);
        }
      },
      handleChainEnd: async () => {
        /* no-op */
      },
    };

    await runAsync({ agentName: "fixture-trace" }, async () => {
      await replayStreamingTokens(composedHandler, 10);
    });

    expect(llmRunId).toBe("llm_stream"); // sanity that fixture id matches
    const last = getLastTrace();
    expect(last).not.toBeNull();
    const llmSpans = (last!.spans as WireSpan[]).filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    expect(llmSpans[0]!.metadata?.tokens_streamed).toBe(10);
  });

  it("initialises tokens_streamed to 1 on the first token (no pre-existing metadata)", async () => {
    const state = freshState();
    const handlers = createStreamingHandlers(state);
    const runId = "first_token";

    await runAsync({ agentName: "first-tok" }, async () => {
      const handle = startSpan({ name: "fake-llm", type: "llm" });
      state.llmSpans.set(runId, handle!);
      await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: 0 }, runId);
      handle!.end();
    });

    const last = getLastTrace();
    const llm = (last!.spans as WireSpan[]).find((s) => s.type === "llm")!;
    expect(llm.metadata?.tokens_streamed).toBe(1);
  });

  it("preserves existing metadata fields when incrementing tokens_streamed", async () => {
    const state = freshState();
    const handlers = createStreamingHandlers(state);
    const runId = "run_meta";

    await runAsync({ agentName: "meta-preserve" }, async () => {
      const handle = startSpan({
        name: "fake-llm",
        type: "llm",
        metadata: { provider: "openai", model: "gpt-4o" },
      });
      state.llmSpans.set(runId, handle!);
      await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: 0 }, runId);
      await handlers.handleLLMNewToken!("tok", { prompt: 0, completion: 1 }, runId);
      handle!.end();
    });

    const last = getLastTrace();
    const llm = (last!.spans as WireSpan[]).find((s) => s.type === "llm")!;
    expect(llm.metadata?.provider).toBe("openai");
    expect(llm.metadata?.model).toBe("gpt-4o");
    expect(llm.metadata?.tokens_streamed).toBe(2);
  });
});
