/**
 * MHQ-1880 / MHQ-1442 — `traceparent` on model-client calls, with a span id that
 * equals the exported OTLP span id, and the provider response id on llm spans.
 * Real `@anthropic-ai/sdk` and `openai` clients; `fetch` is replaced, so the
 * request headers that would leave the process are what is asserted. No network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { buildRedactionConfig } from "../src/_internal/redaction";
import { getEngine } from "../src/_internal/otel-provider";
import { otelSpanIdFor } from "../src/_internal/span-ids";
import { type AnthropicClientLike, wrapAnthropic } from "../src/anthropic/index";
import * as morse from "../src/index";
import { MorseCallbackHandler } from "../src/langchain/callback-handler";
import { MorseCallbackHandler as LangGraphHandler } from "../src/langgraph/index";
import { type OpenAiClientLike, wrapOpenAI } from "../src/openai/index";
import { prepareLlmCall } from "../src/propagation";

const MODEL = "claude-haiku-4-5-20251001";
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(01|00)$/;

type Captured = Array<Record<string, string>>;

const MESSAGE = {
  id: "msg_abc",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
};

const SSE = [
  { type: "message_start", message: { ...MESSAGE, content: [], usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join("");

const CHAT = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "gpt-4.1-nano-2025-04-14",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
  usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
};

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function anthropic(captured: Captured): Anthropic {
  const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    captured.push(headersOf(init));
    const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
    return body.stream
      ? new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(MESSAGE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  };
  return new Anthropic({
    apiKey: "test", // pragma: allowlist secret
    baseURL: "https://api.anthropic.test",
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  });
}

function openai(captured: Captured): OpenAI {
  const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    captured.push(headersOf(init));
    return new Response(JSON.stringify(CHAT), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new OpenAI({
    apiKey: "test", // pragma: allowlist secret
    baseURL: "https://api.openai.test/v1",
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  });
}

const wrapA = (c: Anthropic, opts = {}): Anthropic =>
  wrapAnthropic(c as unknown as AnthropicClientLike, opts) as unknown as Anthropic;

const PARAMS = {
  model: MODEL,
  max_tokens: 32,
  messages: [{ role: "user" as const, content: "hi" }],
};

type WireSpan = Record<string, unknown>;

function lastSpans(): WireSpan[] {
  const last = morse._getLastTraceForTesting() as { spans: WireSpan[] } | null;
  expect(last).not.toBeNull();
  return last!.spans;
}

/** Re-configure the engine (after init) so exported OTel spans are recorded. */
function recordExports(): void {
  getEngine().configure({
    endpoint: "http://127.0.0.1:1/api/v1/otlp/v1/traces",
    apiKey: "av_x", // pragma: allowlist secret
    sampleRate: 1.0,
    scheduleDelayMillis: 50,
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
    maxFieldBytes: 65536,
    timeoutMillis: 1000,
    redactionConfig: buildRedactionConfig({ enabled: true }),
    captureForTests: true,
  });
}

async function exportedSpanIds(traceId: string): Promise<Set<string>> {
  await getEngine().flush();
  const spans = getEngine().recorder!.spans.filter((s) => s.spanContext().traceId === traceId);
  return new Set(spans.map((s) => s.spanContext().spanId));
}

function parse(header: string | undefined): { traceId: string; spanId: string; flags: string } {
  const m = TRACEPARENT.exec(header ?? "");
  expect(m, `traceparent ${header}`).not.toBeNull();
  return { traceId: m![1]!, spanId: m![2]!, flags: m![3]! };
}

beforeEach(() => {
  delete process.env.MORSE_PROPAGATE_TRACE_CONTEXT;
  morse._resetForTesting();
  morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
  recordExports();
});

afterEach(() => {
  delete process.env.MORSE_PROPAGATE_TRACE_CONTEXT;
  morse._resetForTesting();
});

describe("otelSpanIdFor", () => {
  it("is the first 16 hex of a hex id, lowercased", () => {
    expect(otelSpanIdFor("ABCDEF0123456789ffffffffffffffff")).toBe("abcdef0123456789");
  });

  it("never returns zero or a non-hex id", () => {
    for (const id of ["0".repeat(32), "not-a-hex-span-id", "", "zz"]) {
      expect(otelSpanIdFor(id)).toMatch(/^[0-9a-f]{16}$/);
      expect(otelSpanIdFor(id)).not.toBe("0".repeat(16));
    }
  });
});

describe("Anthropic", () => {
  it("direct create: the header span id equals the llm span's exported OTLP span id", async () => {
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    await morse.run("agent-a", async () => {
      await client.messages.create(PARAMS);
    });
    await morse.flush();

    const llm = lastSpans().find((s) => s.type === "llm")!;
    const tp = parse(seen[0]!.traceparent);
    expect(tp.spanId).toBe(otelSpanIdFor(llm.span_id as string));
    expect(tp.traceId).toBe(llm.trace_id);
    expect(tp.flags).toBe("01");
    expect(await exportedSpanIds(tp.traceId)).toContain(tp.spanId);
    expect((llm.metadata as Record<string, unknown>).response_id).toBe("msg_abc");
  });

  it("stream: the header names the stream's llm span; response id from message_start", async () => {
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    await morse.run("agent-a", async () => {
      const stream = await client.messages.create({ ...PARAMS, stream: true });
      for await (const e of stream) void e;
    });
    await morse.flush();

    const llm = lastSpans().find((s) => s.type === "llm")!;
    const tp = parse(seen[0]!.traceparent);
    expect(tp.spanId).toBe(otelSpanIdFor(llm.span_id as string));
    expect(await exportedSpanIds(tp.traceId)).toContain(tp.spanId);
    expect((llm.metadata as Record<string, unknown>).response_id).toBe("msg_abc");
    expect((llm.metadata as Record<string, unknown>).streamed).toBe(true);
  });

  it("messages.stream() helper carries the header too", async () => {
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    await morse.run("agent-a", async () => {
      const stream = client.messages.stream(PARAMS);
      await stream.finalMessage();
    });
    const llm = lastSpans().find((s) => s.type === "llm")!;
    expect(parse(seen[0]!.traceparent).spanId).toBe(otelSpanIdFor(llm.span_id as string));
  });

  it("a traceparent the caller set is kept (any header case), and the caller's options are not mutated", async () => {
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    const mine = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const options = { headers: { TraceParent: mine, "x-other": "1" } };
    await morse.run("agent-a", async () => {
      await client.messages.create(PARAMS, options);
    });
    expect(seen[0]!.traceparent).toBe(mine);
    expect(seen[0]!["x-other"]).toBe("1");
    expect(options).toEqual({ headers: { TraceParent: mine, "x-other": "1" } });
  });

  it("caller headers are merged, not replaced", async () => {
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    await morse.run("agent-a", async () => {
      await client.messages.create(PARAMS, { headers: { "x-keep": "yes" } });
    });
    expect(seen[0]!["x-keep"]).toBe("yes");
    expect(seen[0]!.traceparent).toMatch(TRACEPARENT);
  });

  it("no active trace sends nothing", async () => {
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    await client.messages.create(PARAMS);
    expect(seen[0]!.traceparent).toBeUndefined();
  });

  it("opt-out by env var, by init option and by wrap option sends nothing", async () => {
    const run = async (client: Anthropic): Promise<void> => {
      await morse.run("agent-a", async () => {
        await client.messages.create(PARAMS);
      });
    };

    const byWrap: Captured = [];
    await run(wrapA(anthropic(byWrap), { propagateTraceContext: false }));
    expect(byWrap[0]!.traceparent).toBeUndefined();

    for (const value of ["false", "0"]) {
      process.env.MORSE_PROPAGATE_TRACE_CONTEXT = value;
      const byEnv: Captured = [];
      await run(wrapA(anthropic(byEnv)));
      expect(byEnv[0]!.traceparent).toBeUndefined();
    }
    delete process.env.MORSE_PROPAGATE_TRACE_CONTEXT;

    morse.init({ apiKey: "av_x", propagateTraceContext: false }); // pragma: allowlist secret
    const byInit: Captured = [];
    await run(wrapA(anthropic(byInit)));
    expect(byInit[0]!.traceparent).toBeUndefined();
  });

  it("an unsampled trace sends flags 00", async () => {
    getEngine().sampleRate = 0;
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    await morse.run("agent-a", async () => {
      await client.messages.create(PARAMS);
    });
    expect(parse(seen[0]!.traceparent).flags).toBe("00");
  });
});

describe("OpenAI", () => {
  it("chat completions: the header span id equals the llm span's exported OTLP span id", async () => {
    const seen: Captured = [];
    const client = wrapOpenAI(openai(seen) as unknown as OpenAiClientLike) as unknown as OpenAI;
    await morse.run("agent-o", async () => {
      await client.chat.completions.create({
        model: CHAT.model,
        messages: [{ role: "user", content: "hi" }],
      });
    });
    await morse.flush();

    const llm = lastSpans().find((s) => s.type === "llm")!;
    const tp = parse(seen[0]!.traceparent);
    expect(tp.spanId).toBe(otelSpanIdFor(llm.span_id as string));
    expect(await exportedSpanIds(tp.traceId)).toContain(tp.spanId);
  });

  it("no active trace sends nothing; the wrap option opts out", async () => {
    const seen: Captured = [];
    const client = wrapOpenAI(openai(seen) as unknown as OpenAiClientLike) as unknown as OpenAI;
    const params = { model: CHAT.model, messages: [{ role: "user" as const, content: "hi" }] };
    await client.chat.completions.create(params);
    expect(seen[0]!.traceparent).toBeUndefined();

    const off: Captured = [];
    const quiet = wrapOpenAI(openai(off) as unknown as OpenAiClientLike, {
      propagateTraceContext: false,
    }) as unknown as OpenAI;
    await morse.run("agent-o", async () => {
      await quiet.chat.completions.create(params);
    });
    expect(off[0]!.traceparent).toBeUndefined();
  });
});

describe("prepareLlmCall", () => {
  it("handles Headers and tuple arrays without mutating them", async () => {
    await morse.run("agent-p", async () => {
      const h = new Headers({ "x-a": "1" });
      const out = prepareLlmCall({ headers: h }, "ab".repeat(16)) as { headers: Headers };
      expect(out.headers.get("traceparent")).toMatch(TRACEPARENT);
      expect(h.has("traceparent")).toBe(false);

      const arr = [["x-a", "1"]];
      const out2 = prepareLlmCall({ headers: arr }, "ab".repeat(16)) as {
        headers: string[][];
      };
      expect(out2.headers).toHaveLength(2);
      expect(arr).toHaveLength(1);

      const kept = { headers: [["Traceparent", "mine"]] };
      expect(prepareLlmCall(kept, "ab".repeat(16))).toBe(kept);
    });
  });

  it("returns its input unchanged with no trace, no span id, or a non-object", () => {
    const opts = { headers: {} };
    expect(prepareLlmCall(opts, "ab".repeat(16))).toBe(opts);
    expect(prepareLlmCall(undefined, undefined)).toBeUndefined();
    expect(prepareLlmCall("nope", "ab".repeat(16))).toBe("nope");
  });
});

describe("LangChain and LangGraph", () => {
  const result = (rid: string | undefined, messageId = "run-abc") => ({
    generations: [
      [
        {
          text: "ok",
          message: {
            id: messageId,
            response_metadata: rid === undefined ? {} : { id: rid, model_name: MODEL },
          },
        },
      ],
    ],
    llmOutput: {},
  });

  it("records response_metadata.id as metadata.response_id, never message.id", async () => {
    const handler = new MorseCallbackHandler();
    await morse.run("agent-lc", async () => {
      handler.handleChatModelStart({ id: ["x", "ChatAnthropic"] }, [[]], "r1");
      handler.handleLLMEnd(result("msg_lc") as never, "r1");
      handler.handleChatModelStart({ id: ["x", "ChatAnthropic"] }, [[]], "r2");
      handler.handleLLMEnd(result(undefined, "lc_run--123") as never, "r2");
    });
    const llms = lastSpans().filter((s) => s.type === "llm");
    expect(llms).toHaveLength(2);
    expect((llms[0]!.metadata as Record<string, unknown>).response_id).toBe("msg_lc");
    expect((llms[1]!.metadata as Record<string, unknown>).response_id).toBeUndefined();
  });

  it("falls back to llmOutput.id", async () => {
    const handler = new MorseCallbackHandler();
    await morse.run("agent-lc", async () => {
      handler.handleChatModelStart({ id: ["x", "ChatOpenAI"] }, [[]], "r1");
      const r = result(undefined);
      (r.llmOutput as Record<string, unknown>).id = "chatcmpl-9";
      handler.handleLLMEnd(r as never, "r1");
    });
    const llm = lastSpans().find((s) => s.type === "llm")!;
    expect((llm.metadata as Record<string, unknown>).response_id).toBe("chatcmpl-9");
  });

  it("LangGraph handler records it too", async () => {
    const handler = new LangGraphHandler();
    await morse.run("agent-lg", async () => {
      handler.handleChatModelStart({ id: ["x", "ChatAnthropic"] }, [[]], "r1");
      handler.handleLLMEnd(result("msg_lg") as never, "r1");
    });
    const llm = lastSpans().find((s) => s.type === "llm")!;
    expect((llm.metadata as Record<string, unknown>).response_id).toBe("msg_lg");
  });

  it("a wrapped client called inside a LangChain llm span: the header names the span the SDK exports for the call", async () => {
    const seen: Captured = [];
    const client = wrapA(anthropic(seen));
    const handler = new MorseCallbackHandler();
    await morse.run("agent-lc", async () => {
      handler.handleChatModelStart({ id: ["x", "ChatAnthropic"] }, [[]], "r1");
      await client.messages.create(PARAMS);
      handler.handleLLMEnd(result("msg_abc") as never, "r1");
    });
    await morse.flush();
    const llms = lastSpans().filter((s) => s.type === "llm");
    const tp = parse(seen[0]!.traceparent);
    const named = llms.filter((s) => otelSpanIdFor(s.span_id as string) === tp.spanId);
    expect(named).toHaveLength(1);
    expect(await exportedSpanIds(tp.traceId)).toContain(tp.spanId);
  });
});
