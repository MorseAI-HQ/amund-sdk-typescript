/* eslint-disable @typescript-eslint/no-unused-vars -- mock signatures mirror the SDK API; params intentionally unused (pre-existing, surfaced by MHQ-541 rename staging) */
/**
 * Vercel AI adapter tests.
 *
 * Uses a fake `ai` module (not the real `ai` npm package) so the tests
 * don't pull in heavy dependencies. The fake module exposes the same
 * function shapes as Vercel AI's `streamText` / `generateText` /
 * `generateObject`, returning a mock result with a `usage` Promise.
 *
 * The adapter contract under test:
 *   - One `agent` span per top-level call.
 *   - One `llm` child span per function call.
 *   - Multi-step `maxSteps` runs are ONE agent + N llm children, not N agents.
 *   - W3C `traceparent` injected on outbound fetch.
 *   - Non-invasive: a thrown wrapper does not break the customer call.
 *
 * MHQ-758: `createTracedVercelAI()` returns traced *replacement* functions
 * rather than mutating the passed-in module — real `ai` exports are
 * non-configurable getters and can't be reassigned in place. See
 * `src/vercel-ai/index.ts`'s module doc for the full story.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { createTracedVercelAI } from "../src/vercel-ai/index";
import { type BatchTransport, type BatchTransportOptions } from "../src/_internal/transport";

// ---------- fake `ai` module ----------

interface FakeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface FakeStreamTextResult {
  textStream: AsyncIterable<string>;
  usage: Promise<FakeUsage>;
  finishReason: Promise<string>;
  text: Promise<string>;
}

function makeFakeAiModule(): Record<string, unknown> {
  return {
    streamText(args: { model: { modelId: string }; maxSteps?: number }): FakeStreamTextResult {
      const usage: FakeUsage = { promptTokens: 12, completionTokens: 34, totalTokens: 46 };
      let resolveUsage!: (u: FakeUsage) => void;
      const usagePromise = new Promise<FakeUsage>((resolve) => {
        resolveUsage = resolve;
      });
      // Resolve on next tick so the test sees the agent span complete
      // after the inner llm span.
      setTimeout(() => resolveUsage(usage), 0);
      return {
        textStream: (async function* gen() {
          yield "hello";
          yield " world";
        })(),
        usage: usagePromise,
        finishReason: Promise.resolve("stop"),
        text: Promise.resolve("hello world"),
      };
    },
    async generateText(args: {
      model: { modelId: string };
    }): Promise<{ text: string; usage: FakeUsage }> {
      return {
        text: "ok",
        usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
      };
    },
    async generateObject(args: {
      model: { modelId: string };
    }): Promise<{ object: { ok: boolean }; usage: FakeUsage }> {
      return {
        object: { ok: true },
        usage: { promptTokens: 7, completionTokens: 8, totalTokens: 15 },
      };
    },
  };
}

// ---------- transport mock (to capture sent traces) ----------

interface MockTransport {
  events: unknown[];
}

function installMockTransport(): MockTransport {
  const state: MockTransport = { events: [] };
  morse._setTransportFactoryForTesting(
    (_opts: BatchTransportOptions) =>
      ({
        track(event: unknown): boolean {
          state.events.push(event);
          return true;
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      }) as unknown as BatchTransport,
  );
  return state;
}

beforeEach(() => {
  morse._resetForTesting();
  process.env.MORSE_API_KEY = "av_x";
});

afterEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_API_KEY;
});

describe("createTracedVercelAI — resolution", () => {
  it("returns wrapped functions distinct from, and never mutating, the module's own", async () => {
    const ai = makeFakeAiModule();
    const originalStreamText = ai.streamText;
    const traced = await createTracedVercelAI({ aiModule: ai });
    expect(traced.streamText).not.toBe(ai.streamText);
    expect(traced.generateText).not.toBe(ai.generateText);
    expect(traced.generateObject).not.toBe(ai.generateObject);
    // The passed-in module is never mutated — `ai`'s real exports are
    // frozen getters in production and can't be reassigned (MHQ-758).
    expect(ai.streamText).toBe(originalStreamText);
  });

  it("throws when no `ai` module can be loaded", async () => {
    // No explicit module + the real `ai` package isn't installed in the
    // test environment, so dynamic import fails.
    await expect(createTracedVercelAI()).rejects.toThrow(/could not resolve/);
  });
});

// MHQ-482: `run()`/`span()`'s emission path now goes through the real OTel
// pipeline (`_internal/otel-provider.ts`), not the JSON `BatchTransport` —
// mirrors the Python SDK's MHQ-668 split. `_getLastTraceForTesting()` stays
// wired up regardless of which pipeline actually ships the trace (see
// `tracing.ts::sendTrace`), so it's the right introspection point here.
// MHQ-1156: llm spans carried neither input_data nor output_data.
describe("createTracedVercelAI — llm input/output capture", () => {
  function llmSpan(): Record<string, unknown> {
    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    expect(last).not.toBeNull();
    return last!.spans.find((s) => s.type === "llm")!;
  }

  it("generateText: llm span carries messages/system input and text output", async () => {
    morse.init({ apiKey: "av_x" });
    const { generateText } = await createTracedVercelAI({
      aiModule: makeFakeAiModule(),
      patchGlobalFetch: false,
    });
    await (generateText as (args: unknown) => Promise<unknown>)({
      model: { modelId: "fake-model" },
      system: "be terse",
      messages: [{ role: "user", content: "why observability?" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const llm = llmSpan();
    expect(llm.input_data).toEqual({
      messages: [{ role: "user", content: "why observability?" }],
      system: "be terse",
    });
    expect(llm.output_data).toEqual({ content: "ok" });
  });

  it("generateObject: a bare prompt is the input, the object is the output", async () => {
    morse.init({ apiKey: "av_x" });
    const { generateObject } = await createTracedVercelAI({
      aiModule: makeFakeAiModule(),
      patchGlobalFetch: false,
    });
    await (generateObject as (args: unknown) => Promise<unknown>)({
      model: { modelId: "fake-model" },
      prompt: "is it ok?",
    });
    await new Promise((r) => setTimeout(r, 10));

    const llm = llmSpan();
    expect(llm.input_data).toEqual({ messages: [{ role: "user", content: "is it ok?" }] });
    expect(llm.output_data).toEqual({ content: '{"ok":true}' });
  });

  it("streamText: llm span carries input and the final streamed text", async () => {
    morse.init({ apiKey: "av_x" });
    const { streamText } = await createTracedVercelAI({
      aiModule: makeFakeAiModule(),
      patchGlobalFetch: false,
    });
    const result = (streamText as (args: unknown) => unknown)({
      model: { modelId: "fake-model" },
      prompt: "say hello",
    }) as FakeStreamTextResult;
    for await (const _chunk of result.textStream) {
      // no-op
    }
    await result.usage;
    await new Promise((r) => setTimeout(r, 10));

    const llm = llmSpan();
    expect(llm.input_data).toEqual({ messages: [{ role: "user", content: "say hello" }] });
    expect(llm.output_data).toEqual({ content: "hello world" });
  });

  it("captured input/output go through the redaction path", async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    ai.generateText = async () => ({
      text: "noted 123-45-6789",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const { generateText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });
    await (generateText as (args: unknown) => Promise<unknown>)({
      model: { modelId: "fake-model" },
      prompt: "my ssn is 123-45-6789",
    });
    await new Promise((r) => setTimeout(r, 10));

    const llm = llmSpan();
    const wire = JSON.stringify([llm.input_data, llm.output_data]);
    expect(wire).not.toContain("123-45-6789");
    expect(wire.match(/\[REDACTED:ssn\]/g)).toHaveLength(2);
  });
});

describe("createTracedVercelAI — span tree", () => {
  it("generateText emits one agent span with one llm child", async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    const { generateText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    const result = await (generateText as (args: unknown) => Promise<unknown>)({
      model: { modelId: "fake-model" },
    });
    expect(result).toMatchObject({ text: "ok" });

    // Wait for the trace to be flushed (runAsync).
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    expect(last).not.toBeNull();
    const spans = last!.spans;
    const agentSpans = spans.filter((s) => s.type === "agent");
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(agentSpans.length).toBe(1);
    expect(llmSpans.length).toBe(1);
  });

  it("streamText emits one agent + one llm child for a single call", async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    const { streamText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    const result = (streamText as (args: unknown) => unknown)({
      model: { modelId: "fake-model" },
    }) as FakeStreamTextResult;
    // Consume the stream to trigger usage resolution (the fake's setTimeout).
    for await (const _chunk of result.textStream) {
      // no-op
    }
    await result.usage;

    // Allow the runAsync wrapper to finish.
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    expect(last).not.toBeNull();
    const spans = last!.spans;
    const agentSpans = spans.filter((s) => s.type === "agent");
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(agentSpans.length).toBe(1);
    expect(llmSpans.length).toBe(1);
  });

  // MHQ-750: Vercel AI's `messages`/`tools` call args are already
  // OpenAI-chat-format-compatible, so the shared context-decomposer
  // (`_agent-sdk-common/context-decomposer`) applies directly.
  it("generateText decomposes messages/tools into context_segments on the llm span", async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    const { generateText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    await (generateText as (args: unknown) => Promise<unknown>)({
      model: { modelId: "fake-model" },
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hi there" },
      ],
      tools: { get_weather: { description: "get weather" } },
    });

    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llmSpan = last!.spans.find((s) => s.type === "llm")!;
    const segs = llmSpan.context_segments as
      | Array<{ source: string; content?: string; attrs?: Record<string, unknown> }>
      | undefined;
    expect(segs).toBeDefined();
    expect(segs!.some((s) => s.source === "system_prompt" && s.content === "You are helpful")).toBe(
      true,
    );
    expect(segs!.some((s) => s.source === "current_input" && s.content === "hi there")).toBe(true);
    const toolSeg = segs!.find((s) => s.source === "tool_descriptions");
    expect(toolSeg?.attrs?.tool_names).toContain("get_weather");
  });

  it("streamText omits context_segments when no messages/tools are passed", async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    const { streamText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    const result = (streamText as (args: unknown) => unknown)({
      model: { modelId: "fake-model" },
    }) as FakeStreamTextResult;
    for await (const _chunk of result.textStream) {
      // no-op
    }
    await result.usage;
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llmSpan = last!.spans.find((s) => s.type === "llm")!;
    expect(llmSpan.context_segments).toBeUndefined();
  });
});

// MHQ-789: model/tokens/cost were written to `span.metadata` instead of
// the top-level `span.model`/`.input_tokens`/etc. fields the dashboard
// reads, and cost was never computed at all. Assert both are now correct
// on the top-level span, using a real-priced model id so cost isn't zero.
describe("createTracedVercelAI — model/tokens/cost land on top-level span fields (MHQ-789)", () => {
  it("generateText sets model, tokens, and a real cost on the span itself", async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    const { generateText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    await (generateText as (args: unknown) => Promise<unknown>)({
      model: { modelId: "gpt-4o-mini" },
    });
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as {
      spans: Array<{
        type: string;
        model?: string;
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        cost_usd?: number;
        metadata?: Record<string, unknown>;
      }>;
    } | null;
    const llmSpan = last!.spans.find((s) => s.type === "llm")!;
    expect(llmSpan.model).toBe("gpt-4o-mini");
    expect(llmSpan.input_tokens).toBe(5);
    expect(llmSpan.output_tokens).toBe(6);
    expect(llmSpan.total_tokens).toBe(11);
    expect(typeof llmSpan.cost_usd).toBe("number");
    expect(llmSpan.cost_usd as number).toBeGreaterThan(0);
    expect(llmSpan.metadata?.adapter).toBe("vercel-ai");
  });

  it("streamText sets model, tokens, and a real cost on the span itself", async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    const { streamText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    const result = (streamText as (args: unknown) => unknown)({
      model: { modelId: "gpt-4o-mini" },
    }) as FakeStreamTextResult;
    for await (const _chunk of result.textStream) {
      // no-op
    }
    await result.usage;
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as {
      spans: Array<{
        type: string;
        model?: string;
        input_tokens?: number;
        cost_usd?: number;
      }>;
    } | null;
    const llmSpan = last!.spans.find((s) => s.type === "llm")!;
    expect(llmSpan.model).toBe("gpt-4o-mini");
    expect(llmSpan.input_tokens).toBe(12);
    expect(typeof llmSpan.cost_usd).toBe("number");
    expect(llmSpan.cost_usd as number).toBeGreaterThan(0);
  });

  it('falls back to model: "unknown" (not a dropped span) when no model id is given', async () => {
    morse.init({ apiKey: "av_x" });
    const ai = makeFakeAiModule();
    const { generateText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    await (generateText as (args: unknown) => Promise<unknown>)({});
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as {
      spans: Array<{ type: string; model?: string; cost_usd?: number }>;
    } | null;
    const llmSpan = last!.spans.find((s) => s.type === "llm")!;
    expect(llmSpan.model).toBe("unknown");
    expect(llmSpan.cost_usd).toBeUndefined();
  });
});

describe("createTracedVercelAI — non-invasive", () => {
  it("a wrapped call still returns the original result on adapter error", async () => {
    installMockTransport();
    const ai = makeFakeAiModule();
    const { generateText } = await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: false });

    // Force the trace state to be invalid mid-call so the wrapper's
    // span recording fails. The customer's call must still resolve.
    const result = await (generateText as (args: unknown) => Promise<unknown>)({
      model: { modelId: "fake-model" },
    });
    expect(result).toMatchObject({ text: "ok" });
  });
});

describe("global fetch patching", () => {
  it("injects traceparent on outbound fetch inside a trace", async () => {
    const ai = makeFakeAiModule();
    const originalFetch = globalThis.fetch;

    let capturedHeaders: Headers | null = null;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers ?? {});
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    try {
      await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: true });

      await morse.runTraced({ agentName: "useChat" }, async () => {
        await globalThis.fetch("https://example.test/chat", { method: "POST" });
      });

      expect(capturedHeaders).not.toBeNull();
      const tp = capturedHeaders!.get("traceparent");
      expect(tp).not.toBeNull();
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does NOT inject traceparent outside a trace", async () => {
    const ai = makeFakeAiModule();
    const originalFetch = globalThis.fetch;

    let capturedHeaders: Headers | null = null;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers ?? {});
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    try {
      await createTracedVercelAI({ aiModule: ai, patchGlobalFetch: true });
      await globalThis.fetch("https://example.test/chat", { method: "POST" });
      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get("traceparent")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
