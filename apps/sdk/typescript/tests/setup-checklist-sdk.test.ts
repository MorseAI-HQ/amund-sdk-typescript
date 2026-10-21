/**
 * SETUP-09 / SETUP-10: Responses thread facts and opt-in hashed end-user capture.
 * Fakes only — no real API calls.
 */

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { wrapAnthropic } from "../src/anthropic/index";
import { wrapOpenAI, type OpenAiClientLike } from "../src/openai/index";

const RAW = "alice@x.com";
const HASHED = "h:" + createHash("sha256").update(RAW).digest("hex").slice(0, 32);

const responsesResult = () => ({
  id: "r2",
  model: "gpt-4o-mini",
  output_text: "hi",
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
});
const chatResult = () => ({
  id: "c1",
  model: "gpt-4o-mini",
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  choices: [{ message: { role: "assistant", content: "ok" } }],
});

function fakeOpenAi(): OpenAiClientLike {
  return {
    chat: { completions: { create: vi.fn(async () => chatResult()) } },
    responses: { create: vi.fn(async () => responsesResult()) },
  } as unknown as OpenAiClientLike;
}

function fakeAnthropic() {
  return {
    messages: {
      create: vi.fn(async () => ({
        id: "m1",
        model: "claude-haiku-4-5",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: "x" }],
      })),
    },
  };
}

type Last = { trace: Record<string, unknown>; spans: Record<string, unknown>[] };
const last = (): Last => morse._getLastTraceForTesting() as unknown as Last;
const llm = (): Record<string, unknown> => last().spans.find((s) => s.type === "llm")!;
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  morse._resetForTesting();
  process.env.MORSE_API_KEY = "av_x"; // pragma: allowlist secret
});
afterEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_API_KEY;
});

describe("SETUP-09 thread facts", () => {
  it("Responses call carries response_id, previous_response_id, conversation_id", async () => {
    // @spec: SETUP-09
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const c = wrapOpenAI(fakeOpenAi());
    await c.responses!.create({
      model: "m",
      input: "hi",
      previous_response_id: "r1",
      conversation: "conv_9",
    });
    await settle();
    const span = llm();
    expect(span.name).toBe("openai.responses.create");
    expect(span.input_tokens).toBe(3);
    expect(span.metadata).toMatchObject({
      response_id: "r2",
      previous_response_id: "r1",
      conversation_id: "conv_9",
    });
  });

  it("absent keys are not set; conversation object uses its id", async () => {
    // @spec: SETUP-09
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const c = wrapOpenAI(fakeOpenAi());
    await c.responses!.create({ model: "m", input: "hi" });
    await settle();
    const md = llm().metadata as Record<string, unknown>;
    expect(md.response_id).toBe("r2");
    expect("previous_response_id" in md).toBe(false);
    expect("conversation_id" in md).toBe(false);

    await c.responses!.create({ model: "m", input: "hi", conversation: { id: "conv_obj" } });
    await settle();
    expect((llm().metadata as Record<string, unknown>).conversation_id).toBe("conv_obj");
  });

  it("chat completions get no thread facts", async () => {
    // @spec: SETUP-09
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const c = wrapOpenAI(fakeOpenAi());
    await c.chat.completions.create({ model: "m", messages: [{ role: "user", content: "x" }] });
    await settle();
    expect((llm().metadata as Record<string, unknown>).response_id).toBeUndefined();
  });
});

describe("SETUP-10 end-user capture", () => {
  it("off by default: raw value never sent, no user_id", async () => {
    // @spec: SETUP-10
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const c = wrapOpenAI(fakeOpenAi());
    await c.responses!.create({ model: "m", input: "hi", user: RAW });
    await settle();
    expect(last().trace.user_id).toBeUndefined();
    expect(JSON.stringify(last())).not.toContain(RAW);
  });

  it("on: OpenAI user and safety_identifier are hashed", async () => {
    // @spec: SETUP-10
    morse.init({ apiKey: "av_x", captureEndUser: true }); // pragma: allowlist secret
    const c = wrapOpenAI(fakeOpenAi());
    await c.responses!.create({ model: "m", input: "hi", user: RAW });
    await settle();
    expect(last().trace.user_id).toBe(HASHED);
    expect(JSON.stringify(last())).not.toContain(RAW);

    await c.responses!.create({ model: "m", input: "hi", safety_identifier: RAW });
    await settle();
    expect(last().trace.user_id).toBe(HASHED);

    await c.chat.completions.create({ model: "m", messages: [], user: RAW });
    await settle();
    expect(last().trace.user_id).toBe(HASHED);
  });

  it("app-set userId wins; customer_id is never set", async () => {
    // @spec: SETUP-10
    morse.init({ apiKey: "av_x", captureEndUser: true }); // pragma: allowlist secret
    const c = wrapOpenAI(fakeOpenAi());
    await morse.run({ agentName: "a", userId: "app-user-1" }, async () => {
      await c.responses!.create({ model: "m", input: "hi", user: RAW });
      return null;
    });
    await settle();
    expect(last().trace.user_id).toBe("app-user-1");

    await c.responses!.create({ model: "m", input: "hi", user: RAW });
    await settle();
    const t = last().trace;
    expect(t.user_id).toBe(HASHED);
    expect(t.customer_id).toBeUndefined();
    expect((t.user_metadata as Record<string, unknown> | undefined)?.customer_id).toBeUndefined();
  });

  it("Anthropic metadata.user_id: off by default, hashed when on", async () => {
    // @spec: SETUP-10
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const off = wrapAnthropic(fakeAnthropic() as unknown as Parameters<typeof wrapAnthropic>[0]);
    const params = {
      model: "claude-haiku-4-5",
      max_tokens: 5,
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: RAW },
    };
    await off.messages.create(params as never);
    await settle();
    expect(last().trace.user_id).toBeUndefined();

    morse.init({ apiKey: "av_x", captureEndUser: true }); // pragma: allowlist secret
    const on = wrapAnthropic(fakeAnthropic() as unknown as Parameters<typeof wrapAnthropic>[0]);
    await on.messages.create(params as never);
    await settle();
    expect(last().trace.user_id).toBe(HASHED);
    expect(JSON.stringify(last())).not.toContain(RAW);
  });
});
