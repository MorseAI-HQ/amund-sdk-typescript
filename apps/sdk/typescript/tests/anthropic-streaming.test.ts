/**
 * MHQ-1415 — Anthropic streaming in the TS SDK.
 *
 * Dogfood 2026-10-18 (group I): `create({ stream: true })` produced an llm span
 * with no usage, so the server estimated 4 input / 0 output tokens and the cost
 * was wrong (trace 190ee633…). Usage arrives in `message_start` /
 * `message_delta` events and is now accumulated into the span.
 *
 * Real `@anthropic-ai/sdk` client, `fetch` replaced by a recorded SSE body.
 */
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Anthropic from "@anthropic-ai/sdk";

import * as morse from "../src/index";
import {
  type AnthropicClientLike,
  instrumentAnthropic,
  uninstallAnthropic,
  wrapAnthropic,
} from "../src/anthropic/index";

const MODEL = "claude-haiku-4-5-20251001";

const EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  },
  { type: "message_stop" },
];

const SSE = EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function client(status = 200, Ctor: typeof Anthropic = Anthropic): Anthropic {
  const fetchImpl = async (): Promise<Response> =>
    status === 200
      ? new Response(SSE, { status, headers: { "content-type": "text/event-stream" } })
      : new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          }),
          { status, headers: { "content-type": "application/json" } },
        );
  return new Ctor({
    apiKey: "test", // pragma: allowlist secret
    baseURL: "https://api.anthropic.test",
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  });
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let n = 0;
  for await (const event of stream) if (event) n += 1;
  return n;
}

function wrap(c: Anthropic): Anthropic {
  return wrapAnthropic(c as unknown as AnthropicClientLike) as unknown as Anthropic;
}

const PARAMS = {
  model: MODEL,
  max_tokens: 32,
  messages: [{ role: "user" as const, content: "hi" }],
};

type WireSpan = Record<string, unknown>;

function llmSpans(): WireSpan[] {
  const last = morse._getLastTraceForTesting() as { spans: WireSpan[] } | null;
  expect(last).not.toBeNull();
  return last!.spans.filter((s) => s.type === "llm");
}

function expectFullSpan(span: WireSpan): void {
  expect(span.model).toBe(MODEL);
  expect(span.input_tokens).toBe(162); // 12 + 50 written + 100 read
  expect(span.output_tokens).toBe(7);
  expect(span.cache_write_tokens).toBe(50);
  expect(span.cached_input_tokens).toBe(100);
  expect(span.output_data).toEqual({ content: "Hello" });
  expect((span.metadata as Record<string, unknown>).streamed).toBe(true);
}

beforeEach(() => {
  morse._resetForTesting();
  morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
});

afterEach(() => {
  morse._resetForTesting();
});

describe("Anthropic streaming (MHQ-1415)", () => {
  it("create({ stream: true }) inside run() records model, tokens and cache tokens", async () => {
    const wrapped = wrap(client());
    await morse.run({ agentName: "stream-agent" }, async () => {
      const stream = await wrapped.messages.create({ ...PARAMS, stream: true });
      await drain(stream);
    });
    const spans = llmSpans();
    expect(spans).toHaveLength(1);
    expectFullSpan(spans[0]!);
    expect(spans[0]!.status).toBe("completed");
  });

  it("create({ stream: true }) with no open trace gets its own trace", async () => {
    const wrapped = wrap(client());
    const stream = await wrapped.messages.create({ ...PARAMS, stream: true });
    await drain(stream);
    await new Promise((r) => setTimeout(r, 10));
    const spans = llmSpans();
    expect(spans).toHaveLength(1);
    expectFullSpan(spans[0]!);
  });

  it("messages.stream() on a wrapped client is traced", async () => {
    const wrapped = wrap(client());
    await morse.run({ agentName: "stream-helper" }, async () => {
      const ms = wrapped.messages.stream(PARAMS);
      const final = await ms.finalMessage();
      expect(final.content[0]).toMatchObject({ type: "text", text: "Hello" });
    });
    const spans = llmSpans();
    expect(spans).toHaveLength(1);
    expectFullSpan(spans[0]!);
  });

  it("a stream the caller abandons is kept and marked incomplete", async () => {
    const wrapped = wrap(client());
    await morse.run({ agentName: "early-exit" }, async () => {
      const stream = await wrapped.messages.create({ ...PARAMS, stream: true });
      for await (const event of stream) {
        if (event.type === "content_block_delta") break;
      }
    });
    const [span] = llmSpans();
    expect(span!.model).toBe(MODEL);
    expect((span!.metadata as Record<string, unknown>).stream_incomplete).toBe(true);
  });

  it("keeps the SDK's APIPromise: create().withResponse() still works on a wrapped client", async () => {
    const wrapped = wrap(client());
    await morse.run({ agentName: "with-response" }, async () => {
      const { data, response } = await wrapped.messages
        .create({ ...PARAMS, stream: true })
        .withResponse();
      expect(response.status).toBe(200);
      await drain(data);
    });
    expectFullSpan(llmSpans()[0]!);
  });

  it("zero-config prototype install: messages.stream() works and is traced (was: withResponse is not a function)", async () => {
    // auto-detect hands instrumentAnthropic the CommonJS module object.
    const mod = createRequire(import.meta.url)("@anthropic-ai/sdk") as {
      default: typeof Anthropic;
    };
    const installed = await instrumentAnthropic({ anthropicModule: mod });
    expect(installed).toBe(true);
    try {
      const raw = client(200, mod.default);
      await morse.run({ agentName: "auto-detect" }, async () => {
        const final = await raw.messages.stream(PARAMS).finalMessage();
        expect(final.content[0]).toMatchObject({ type: "text", text: "Hello" });
      });
      const spans = llmSpans();
      expect(spans).toHaveLength(1);
      expectFullSpan(spans[0]!);
    } finally {
      uninstallAnthropic(mod);
    }
  });

  it("a failed streaming request records a failed llm span with the requested model", async () => {
    const wrapped = wrap(client(401));
    await expect(
      morse.run({ agentName: "stream-fail" }, async () => {
        await wrapped.messages.create({ ...PARAMS, stream: true });
      }),
    ).rejects.toThrow();
    const [span] = llmSpans();
    expect(span!.status).toBe("failed");
    expect(span!.model).toBe(MODEL);
    expect(span!.input_tokens).toBeUndefined();
  });
});
