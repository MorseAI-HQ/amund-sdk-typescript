/**
 * Plain OpenAI adapter (`@morsehq/sdk/openai`) tests (MHQ-747).
 *
 * Mirrors `apps/sdk/python/tests/test_openai_context_segments.py`'s
 * `wrap()` integration coverage granularity: llm span emission, token/cost
 * extraction, context_segments populated from messages+tools, idempotent
 * double-wrap, and the error path (re-raises + marks span failed). Follows
 * the structure of `tests/anthropic-context-segments.test.ts`'s
 * `wrapAnthropic` integration block.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import {
  isOpenAiWrapped,
  wrapOpenAI,
  type OpenAiChatCompletionCreateParams,
  type OpenAiChatCompletionResponse,
  type OpenAiClientLike,
} from "../src/openai/index";

/* ------------------------------------------------------------------------ */
/*  Test scaffolding                                                         */
/* ------------------------------------------------------------------------ */

function makeFakeClient(
  responseFactory: (params: OpenAiChatCompletionCreateParams) => OpenAiChatCompletionResponse,
): OpenAiClientLike & { _create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (params: OpenAiChatCompletionCreateParams) => responseFactory(params));
  return {
    chat: { completions: { create } },
    _create: create,
  } as unknown as OpenAiClientLike & { _create: ReturnType<typeof vi.fn> };
}

const baseResponse = (
  model = "gpt-4o-mini",
  promptTokens = 10,
  completionTokens = 5,
): OpenAiChatCompletionResponse => ({
  id: "chatcmpl_test",
  model,
  usage: {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  },
  choices: [{ message: { role: "assistant", content: "ok" } }],
});

beforeEach(() => {
  morse._resetForTesting();
  process.env.MORSE_API_KEY = "av_x"; // pragma: allowlist secret
});

afterEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_API_KEY;
});

/* ------------------------------------------------------------------------ */
/*  wrapOpenAI — llm span emission + context_segments                        */
/* ------------------------------------------------------------------------ */

describe("wrapOpenAI — adds llm span with context_segments", () => {
  it("adds llm span carrying context_segments to the active trace state", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret

    const client = makeFakeClient(() => baseResponse());
    const wrapped = wrapOpenAI(client);
    expect(isOpenAiWrapped(wrapped)).toBe(true);
    expect(isOpenAiWrapped(client)).toBe(false);

    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a coding assistant" },
        { role: "user", content: "write a hello world" },
      ],
    });
    // wait for the runAsync wrapper to flush the trace
    await new Promise((r) => setTimeout(r, 10));

    expect(client._create).toHaveBeenCalledTimes(1);
    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    expect(last).not.toBeNull();
    const spans = last!.spans;
    const llm = spans.find((s) => s.type === "llm") as Record<string, unknown> | undefined;
    expect(llm).toBeDefined();
    expect(llm!.model).toBe("gpt-4o-mini");

    const segments = llm!.context_segments as Array<Record<string, unknown>> | undefined;
    expect(segments).toBeDefined();
    expect(segments!.map((s) => s.source)).toEqual(["system_prompt", "current_input"]);
    const sysSeg = segments!.find((s) => s.source === "system_prompt");
    const curSeg = segments!.find((s) => s.source === "current_input");
    expect(sysSeg!.content).toBe("You are a coding assistant");
    expect(curSeg!.content).toBe("write a hello world");
  });

  it("tools array present → tool_descriptions segment with tool_count attr", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const client = makeFakeClient(() => baseResponse("gpt-4o"));
    const wrapped = wrapOpenAI(client);

    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "get weather" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llm = last!.spans.find((s) => s.type === "llm") as Record<string, unknown>;
    const segments = llm.context_segments as Array<Record<string, unknown>>;
    const toolSeg = segments.find((s) => s.source === "tool_descriptions");
    expect(toolSeg).toBeDefined();
    expect((toolSeg!.attrs as Record<string, unknown>).tool_count).toBe(1);
  });

  it("tool role message emits a tool_observation segment", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const client = makeFakeClient(() => baseResponse());
    const wrapped = wrapOpenAI(client);

    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "get weather" },
        { role: "assistant", content: null },
        { role: "tool", content: "sunny, 25C", tool_call_id: "call_1" },
        { role: "user", content: "thanks" },
      ],
    });
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llm = last!.spans.find((s) => s.type === "llm") as Record<string, unknown>;
    const segments = llm.context_segments as Array<Record<string, unknown>>;
    const obs = segments.filter((s) => s.source === "tool_observation");
    expect(obs).toHaveLength(1);
    expect(String(obs[0]!.content)).toContain("sunny, 25C");
  });
});

/* ------------------------------------------------------------------------ */
/*  wrapOpenAI — telemetry: tokens, model, cost                              */
/* ------------------------------------------------------------------------ */

describe("wrapOpenAI — token/cost extraction", () => {
  it("surfaces model, input_tokens, output_tokens, total_tokens, cost_usd", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const client = makeFakeClient(() => baseResponse("gpt-4o", 25, 10));
    const wrapped = wrapOpenAI(client);

    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llm = last!.spans.find((s) => s.type === "llm") as Record<string, unknown>;
    expect(llm.model).toBe("gpt-4o");
    expect(llm.input_tokens).toBe(25);
    expect(llm.output_tokens).toBe(10);
    expect(llm.total_tokens).toBe(35);
    expect(typeof llm.cost_usd).toBe("number");
    expect(llm.cost_usd as number).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  wrapOpenAI — idempotency + call-through behavior                         */
/* ------------------------------------------------------------------------ */

describe("wrapOpenAI — idempotent + non-invasive", () => {
  it("wrapping the same client twice is idempotent", () => {
    const client = makeFakeClient(() => baseResponse());
    const w1 = wrapOpenAI(client);
    const w2 = wrapOpenAI(w1);
    expect(w2).toBe(w1);
  });

  it("propagates the underlying call's return value verbatim", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const client = makeFakeClient(() => ({
      id: "chatcmpl_xyz",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      choices: [{ message: { role: "assistant", content: "answer" } }],
    }));
    const wrapped = wrapOpenAI(client);
    const result = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.id).toBe("chatcmpl_xyz");
    expect(result.choices?.[0]?.message?.content).toBe("answer");
  });

  it("emits one llm span per call when run inside an existing trace", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const client = makeFakeClient(() => baseResponse());
    const wrapped = wrapOpenAI(client);

    await morse.runTraced({ agentName: "outer-agent" }, async () => {
      await wrapped.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "first" }],
      });
      await wrapped.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "second" }],
      });
      return null;
    });

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llmSpans = last!.spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------ */
/*  wrapOpenAI — error path                                                  */
/* ------------------------------------------------------------------------ */

describe("wrapOpenAI — error path", () => {
  it("re-raises the underlying error unchanged and marks the span failed", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const error = new Error("rate limited");
    const client: OpenAiClientLike = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw error;
          }),
        },
      },
    } as unknown as OpenAiClientLike;
    const wrapped = wrapOpenAI(client);

    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "q" }],
      }),
    ).rejects.toThrow("rate limited");

    await new Promise((r) => setTimeout(r, 10));
    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    expect(last).not.toBeNull();
    const llm = last!.spans.find((s) => s.type === "llm") as Record<string, unknown> | undefined;
    expect(llm).toBeDefined();
    expect(llm!.status).toBe("failed");
  });
});
