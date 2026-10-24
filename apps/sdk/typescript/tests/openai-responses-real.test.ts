/**
 * MHQ-1411 item 3 — launch repro on the real `openai` client.
 *
 * Dogfood 2026-10-18 (group E): two calls, one `chat.completions.create` and
 * one `responses.create`, on a `wrapOpenAI` client produced ONE llm span
 * (trace d1278329…). The real SDK is used here with `fetch` replaced by
 * recorded response bodies, so the wrapped surface is the one customers get.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import OpenAI from "openai";

import * as morse from "../src/index";
import { type OpenAiClientLike, wrapOpenAI } from "../src/openai/index";

const CHAT_BODY = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "gpt-4o-mini-2024-07-18",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
  usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
};

const RESPONSES_BODY = {
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "gpt-4o-mini-2024-07-18",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 20,
    output_tokens: 8,
    total_tokens: 28,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

function client(): OpenAI {
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url instanceof Request ? url.url : url);
    const body = u.endsWith("/responses") ? RESPONSES_BODY : CHAT_BODY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new OpenAI({
    apiKey: "sk-test", // pragma: allowlist secret
    baseURL: "https://api.openai.test/v1",
    fetch: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  });
}

beforeEach(() => {
  morse._resetForTesting();
  morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
});

afterEach(() => {
  morse._resetForTesting();
});

it("MHQ-1411: chat.completions.create and responses.create each record an llm span", async () => {
  const wrapped = wrapOpenAI(client() as unknown as OpenAiClientLike) as unknown as OpenAI;
  await morse.run({ agentName: "openai-two-apis" }, async () => {
    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    const r = await wrapped.responses.create({ model: "gpt-4o-mini", input: "say hello" });
    expect(r.output_text).toBe("hello");
  });
  const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
  const llm = last!.spans.filter((s) => s.type === "llm");
  expect(llm.map((s) => s.name).sort()).toEqual([
    "openai.chat.completions.create",
    "openai.responses.create",
  ]);
  const responses = llm.find((s) => s.name === "openai.responses.create")!;
  expect(responses.input_tokens).toBe(20);
  expect(responses.output_tokens).toBe(8);
  expect(responses.model).toBe("gpt-4o-mini-2024-07-18");
});
