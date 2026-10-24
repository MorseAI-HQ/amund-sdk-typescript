/**
 * MHQ-1407 (TS half) and the `wrapOpenAI` APIPromise fix — real `openai` client,
 * `fetch` replaced by recorded bodies / SSE streams. No key, no network.
 *
 * Before: `create({ stream: true })` on a wrapped client produced an llm span
 * with no model usage, tokens or cost (the stream passed through untraced),
 * and the wrapper returned a plain Promise, so `.withResponse()` threw
 * "withResponse is not a function".
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import OpenAI from "openai";

import * as morse from "../src/index";
import { type OpenAiClientLike, wrapOpenAI } from "../src/openai/index";

const MODEL = "gpt-4.1-nano-2025-04-14";

const CHAT_BODY = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: MODEL,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 2,
    total_tokens: 13,
    prompt_tokens_details: { cached_tokens: 0 },
  },
};

function chatChunks(includeUsage: boolean): unknown[] {
  const base = { id: "chatcmpl-s", object: "chat.completion.chunk", created: 0, model: MODEL };
  const chunks: unknown[] = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
    { ...base, choices: [{ index: 0, delta: { content: "lo" } }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  if (includeUsage) {
    chunks.push({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 8,
        total_tokens: 128,
        prompt_tokens_details: { cached_tokens: 16 },
      },
    });
  }
  return chunks;
}

const RESPONSE_DONE = {
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: MODEL,
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi!", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 50,
    output_tokens: 4,
    total_tokens: 54,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

const RESPONSES_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { ...RESPONSE_DONE, status: "in_progress", output: [], usage: null },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "Hi!",
  },
  { type: "response.completed", sequence_number: 2, response: RESPONSE_DONE },
];

function sse(events: unknown[], done = true): string {
  return (
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "")
  );
}

type Handler = (url: string, body: Record<string, unknown>) => Response;

function client(handler: Handler): OpenAI {
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url instanceof Request ? url.url : url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return handler(u, body);
  };
  return new OpenAI({
    apiKey: "sk-test", // pragma: allowlist secret
    baseURL: "https://api.openai.test/v1",
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  });
}

function streamResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function wrapped(handler: Handler): OpenAI {
  return wrapOpenAI(client(handler) as unknown as OpenAiClientLike) as unknown as OpenAI;
}

function onlyLlm(): Record<string, unknown> {
  const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
  expect(last).not.toBeNull();
  const llm = last!.spans.filter((s) => s.type === "llm");
  expect(llm).toHaveLength(1);
  return llm[0]!;
}

beforeEach(() => {
  morse._resetForTesting();
  morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
});

afterEach(() => {
  morse._resetForTesting();
});

it("MHQ-1407: chat stream with include_usage records model, tokens, cost and output", async () => {
  // @spec: MHQ-1407
  const c = wrapped(() => streamResponse(sse(chatChunks(true))));
  let text = "";
  await morse.run({ agentName: "ts-stream-chat" }, async () => {
    const stream = await c.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
  });
  expect(text).toBe("Hello");
  const llm = onlyLlm();
  expect(llm.model).toBe(MODEL);
  expect(llm.input_tokens).toBe(120);
  expect(llm.output_tokens).toBe(8);
  expect(llm.cached_input_tokens).toBe(16);
  expect(llm.cost_usd as number).toBeGreaterThan(0);
  expect(llm.output_data).toEqual({ content: "Hello" });
  expect((llm.metadata as Record<string, unknown>).streamed).toBe(true);
});

it("MHQ-1407: chat stream without include_usage keeps the model and says usage is missing", async () => {
  // @spec: MHQ-1407
  const c = wrapped(() => streamResponse(sse(chatChunks(false))));
  await morse.run({ agentName: "ts-stream-nousage" }, async () => {
    const stream = await c.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    for await (const _ of stream) void _;
  });
  const llm = onlyLlm();
  expect(llm.model).toBe(MODEL);
  expect(llm.input_tokens).toBeUndefined();
  expect((llm.metadata as Record<string, unknown>).usage_unavailable).toBe(true);
});

it("MHQ-1407: responses stream records usage from response.completed", async () => {
  // @spec: MHQ-1407
  const c = wrapped(() => streamResponse(sse(RESPONSES_EVENTS, false)));
  await morse.run({ agentName: "ts-stream-responses" }, async () => {
    const stream = await c.responses.create({ model: "gpt-4.1-nano", input: "hi", stream: true });
    for await (const _ of stream) void _;
  });
  const llm = onlyLlm();
  expect(llm.name).toBe("openai.responses.create");
  expect(llm.model).toBe(MODEL);
  expect(llm.input_tokens).toBe(50);
  expect(llm.output_tokens).toBe(4);
  expect(llm.cost_usd as number).toBeGreaterThan(0);
});

it("MHQ-1407: a stream returned from run() and read afterwards stays in that trace", async () => {
  // @spec: MHQ-1407
  const c = wrapped(() => streamResponse(sse(chatChunks(true))));
  const stream = (await morse.run({ agentName: "ts-route" }, async () =>
    c.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  )) as AsyncIterable<unknown>;
  expect(morse._getLastTraceForTesting()).toBeNull(); // held open, not yet sent
  for await (const _ of stream) void _;
  await new Promise((r) => setTimeout(r, 10));
  const last = morse._getLastTraceForTesting() as { trace: { agent: string } } | null;
  expect(last?.trace.agent).toBe("ts-route");
  expect(onlyLlm().input_tokens).toBe(120);
});

it("MHQ-1407: a stream read with no trace open still lands in one", async () => {
  // @spec: MHQ-1407
  const c = wrapped(() => streamResponse(sse(chatChunks(true))));
  const stream = await c.chat.completions.create({
    model: "gpt-4.1-nano",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    stream_options: { include_usage: true },
  });
  for await (const _ of stream) void _;
  await new Promise((r) => setTimeout(r, 10));
  const llm = onlyLlm();
  expect(llm.input_tokens).toBe(120);
});

it("wrapOpenAI keeps the APIPromise: .withResponse() works on a wrapped client", async () => {
  // @spec: MHQ-1407
  const c = wrapped(
    () =>
      new Response(JSON.stringify(CHAT_BODY), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_123" },
      }),
  );
  await morse.run({ agentName: "ts-with-response" }, async () => {
    const { data, response } = await c.chat.completions
      .create({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] })
      .withResponse();
    expect(data.choices[0]?.message.content).toBe("hi");
    expect(response.headers.get("x-request-id")).toBe("req_123");
  });
  const llm = onlyLlm();
  expect(llm.input_tokens).toBe(11);
  expect(llm.cached_input_tokens).toBe(0);
});

it("a failed call records a failed llm span with the requested model", async () => {
  // @spec: MHQ-1407
  const c = wrapped(
    () =>
      new Response(
        JSON.stringify({
          error: { message: "The model `gpt-nope` does not exist", type: "invalid_request_error" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
  );
  await expect(
    morse.run({ agentName: "ts-fail" }, async () => {
      await c.chat.completions.create({
        model: "gpt-nope",
        messages: [{ role: "user", content: "hi" }],
      });
    }),
  ).rejects.toThrow(/does not exist/);
  const llm = onlyLlm();
  expect(llm.status).toBe("failed");
  expect(llm.model).toBe("gpt-nope");
  expect(String(llm.exception_type)).toMatch(/NotFoundError/);
  expect(llm.cost_usd).toBeUndefined();
});
