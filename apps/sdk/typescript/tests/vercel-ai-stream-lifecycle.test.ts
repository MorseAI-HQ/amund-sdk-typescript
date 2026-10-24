/**
 * MHQ-1407 (TS half) — Vercel AI SDK `streamText` on the real `ai@7`
 * (`MockLanguageModelV4`, no network), through `createTracedVercelAI()`.
 *
 * Dogfood 2026-10-18 group E, finding 2: bare traced `streamText` recorded the
 * agent span only (no llm span, no tokens, $0), and a Next.js route wrapped in
 * `run()` closed its trace before the stream was read. Finding 11: a failed
 * stream left the trace `status=failed` with `success=true`.
 */
import * as ai from "ai";
import { jsonSchema, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as morse from "../src/index";
import { createTracedVercelAI } from "../src/vercel-ai/index";

type Span = Record<string, unknown>;
type Trace = { trace: Record<string, unknown>; spans: Span[] };

const USAGE = {
  inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function streamModel(parts: unknown[][]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    modelId: "gpt-4.1-nano",
    doStream: async () => {
      const chunks = parts[Math.min(call, parts.length - 1)]!;
      call += 1;
      return {
        stream: simulateReadableStream({ chunks: chunks as never[], chunkDelayInMs: 1 }),
      };
    },
  });
}

function textParts(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

function toolParts(): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      input: JSON.stringify({ q: "x" }),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE },
  ];
}

function lastTrace(): Trace {
  const t = morse._getLastTraceForTesting() as Trace | null;
  expect(t).not.toBeNull();
  return t!;
}

async function waitForTrace(predicate: (t: Trace) => boolean): Promise<Trace> {
  for (let i = 0; i < 200; i++) {
    const t = morse._getLastTraceForTesting() as Trace | null;
    if (t && predicate(t)) return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  return lastTrace();
}

async function drain(stream: AsyncIterable<unknown>): Promise<string> {
  let out = "";
  for await (const piece of stream) out += String(piece);
  return out;
}

beforeEach(() => {
  morse._resetForTesting();
  morse.init({ apiKey: "av_x", endpoint: "http://127.0.0.1:1/api/v1/traces/batch" }); // pragma: allowlist secret
});

afterEach(() => {
  morse._resetForTesting();
});

it("MHQ-1407: bare traced streamText records the llm span with tokens and cost", async () => {
  // @spec: MHQ-1407
  const { streamText } = await createTracedVercelAI({ aiModule: ai });
  const result = streamText({ model: streamModel([textParts("Hello")]), prompt: "hi" }) as {
    textStream: AsyncIterable<string>;
  };
  expect(await drain(result.textStream)).toBe("Hello");
  const t = await waitForTrace((tr) => tr.spans.some((s) => s.type === "llm"));
  const llm = t.spans.filter((s) => s.type === "llm");
  expect(llm).toHaveLength(1);
  expect(llm[0]!.input_tokens).toBe(120);
  expect(llm[0]!.output_tokens).toBe(8);
  expect(llm[0]!.cost_usd as number).toBeGreaterThan(0);
  expect(llm[0]!.output_data).toEqual({ content: "Hello" });
  expect(t.trace.success).toBe(true);
});

it("MHQ-1407: run() around a streamed route keeps the trace open until the stream ends", async () => {
  // @spec: MHQ-1407
  const { streamText } = await createTracedVercelAI({ aiModule: ai });
  // The route shape: run() returns the (unread) stream to the framework.
  const result = (await morse.run({ agentName: "rag-chat" }, async () =>
    streamText({ model: streamModel([textParts("Streamed")]), prompt: "hi" }),
  )) as { textStream: AsyncIterable<string> };
  // run() has returned; nothing has been read yet, so no trace is sent.
  expect(morse._getLastTraceForTesting()).toBeNull();
  expect(await drain(result.textStream)).toBe("Streamed");
  const t = await waitForTrace((tr) => tr.spans.some((s) => s.type === "llm"));
  expect(t.trace.agent).toBe("rag-chat");
  const llm = t.spans.filter((s) => s.type === "llm");
  expect(llm).toHaveLength(1);
  expect(llm[0]!.input_tokens).toBe(120);
  const root = t.spans.find((s) => s.type === "agent")!;
  expect(llm[0]!.parent_span_id).toBe(root.span_id);
});

it("MHQ-1407: tool results become tool spans", async () => {
  // @spec: MHQ-1407
  const { streamText } = await createTracedVercelAI({ aiModule: ai });
  const result = streamText({
    model: streamModel([toolParts(), textParts("done")]),
    prompt: "use the tool",
    tools: {
      lookup: tool({
        description: "lookup",
        inputSchema: jsonSchema<{ q: string }>({
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        }),
        execute: async () => "found",
      }),
    },
    stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= 2,
  }) as { textStream: AsyncIterable<string> };
  await drain(result.textStream);
  const t = await waitForTrace((tr) => tr.spans.some((s) => s.type === "tool"));
  const tools = t.spans.filter((s) => s.type === "tool");
  expect(tools.map((s) => s.name)).toEqual(["lookup"]);
  expect(tools[0]!.output_data).toEqual({ content: "found" });
});

it("MHQ-1407: a failed stream fails the auto-opened trace with success=false", async () => {
  // @spec: MHQ-1407
  const { streamText } = await createTracedVercelAI({ aiModule: ai });
  const model = new MockLanguageModelV4({
    modelId: "gpt-4.1-nano",
    doStream: async () => {
      throw new Error("upstream exploded");
    },
  });
  const result = streamText({ model, prompt: "hi", onError: () => {} }) as {
    textStream: AsyncIterable<string>;
  };
  await drain(result.textStream).catch(() => undefined);
  const t = await waitForTrace((tr) => tr.trace.status === "failed");
  expect(t.trace.status).toBe("failed");
  expect(t.trace.success).toBe(false);
  const llm = t.spans.filter((s) => s.type === "llm");
  expect(llm[0]!.status).toBe("failed");
});
