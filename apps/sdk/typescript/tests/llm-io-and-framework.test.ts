/**
 * MHQ-858 / MHQ-859 — `input_data`/`output_data` capture and framework
 * discovery, the two Python-parity gaps a published-package E2E round on
 * 0.4.1 found (2026-08-02, `apps/sdk/*​/dogfood-published/`).
 *
 * Both were invisible to the existing suite for the same reason: every test
 * asserted the fields the adapter *does* set, and nothing asserted the
 * absence of the ones it doesn't. These assert the wire payload — the shape
 * the backend actually reads — not just that the adapter ran.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  captureInputMessages,
  captureLangChainMessages,
  capturePrompts,
  extractAnthropicOutputText,
  extractLangChainOutputText,
  extractOpenAiOutputText,
  truncateText,
  CONTENT_BYTE_CAP,
} from "../src/_internal/llm-io";
import * as morse from "../src/index";
import { wrapAnthropic } from "../src/anthropic/index";
import { wrapOpenAI, type OpenAiClientLike } from "../src/openai/index";

beforeEach(() => {
  morse._resetForTesting();
  process.env.MORSE_API_KEY = "av_x"; // pragma: allowlist secret
});

afterEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_API_KEY;
});

function lastTrace(): { trace: Record<string, unknown>; spans: Record<string, unknown>[] } {
  const last = morse._getLastTraceForTesting() as {
    trace: Record<string, unknown>;
    spans: Record<string, unknown>[];
  } | null;
  expect(last).not.toBeNull();
  return last!;
}

/* ------------------------------------------------------------------------ */
/*  llm-io helpers                                                           */
/* ------------------------------------------------------------------------ */

describe("llm-io helpers", () => {
  it("truncates on a UTF-8 byte budget, not a code-unit count", () => {
    // 4 bytes per emoji: 2000 of them is 8000 bytes, well over the cap,
    // but only 4000 UTF-16 code units — a .length check would pass it.
    const emoji = "😀".repeat(2000);
    const out = truncateText(emoji);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(CONTENT_BYTE_CAP + 3);
    expect(out.endsWith("…")).toBe(true);
    // Never splits a code point into a lone surrogate.
    expect(out.replace("…", "")).toBe("😀".repeat(1024));
  });

  it("leaves short text untouched", () => {
    expect(truncateText("hello")).toBe("hello");
  });

  it("captureInputMessages truncates string content and keeps block content", () => {
    const blocks = [{ type: "image", source: {} }];
    const captured = captureInputMessages([
      { role: "user", content: "x".repeat(CONTENT_BYTE_CAP + 100) },
      { role: "user", content: blocks },
    ]);
    expect(captured!.messages).toHaveLength(2);
    expect((captured!.messages[0]!.content as string).endsWith("…")).toBe(true);
    expect(captured!.messages[1]!.content).toBe(blocks);
  });

  it("captureInputMessages flattens an Anthropic block-form system prompt", () => {
    const captured = captureInputMessages(
      [{ role: "user", content: "hi" }],
      [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    );
    expect(captured!.system).toBe("line one\nline two");
  });

  it("captureInputMessages returns undefined rather than an empty object", () => {
    expect(captureInputMessages([])).toBeUndefined();
    expect(captureInputMessages(undefined)).toBeUndefined();
    expect(captureInputMessages("not an array")).toBeUndefined();
  });

  it("extractAnthropicOutputText renders a tool-only response", () => {
    const text = extractAnthropicOutputText([
      { type: "tool_use", name: "get_weather", input: { city: "Boston" } },
    ]);
    expect(text).toBe('[tool_use:get_weather] {"city":"Boston"}');
  });

  it("extractOpenAiOutputText renders a tool-call-only response", () => {
    const text = extractOpenAiOutputText([
      { message: { tool_calls: [{ function: { name: "lookup", arguments: '{"id":1}' } }] } },
    ]);
    expect(text).toBe('[tool_call:lookup] {"id":1}');
  });

  it("capturePrompts and extractLangChainOutputText handle the LangChain shapes", () => {
    expect(capturePrompts(["say hi"])!.messages[0]).toEqual({ role: "user", content: "say hi" });
    expect(extractLangChainOutputText([[{ text: "pong" }]])).toBe("pong");
    expect(extractLangChainOutputText([])).toBeUndefined();
  });

  it("captureLangChainMessages reads role off a _getType() message object", () => {
    const lcMessage = { _getType: () => "human", content: "from langchain" };
    const captured = captureLangChainMessages([lcMessage]);
    expect(captured!.messages[0]).toEqual({ role: "user", content: "from langchain" });
  });
});

/* ------------------------------------------------------------------------ */
/*  Adapter wiring — the wire payload, not just the helper                   */
/* ------------------------------------------------------------------------ */

describe("anthropic adapter — input_data/output_data + framework", () => {
  it("captures both, and stamps morse_ai.framework on the trace resource", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const create = vi.fn(async () => ({
      model: "claude-haiku-4-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "three reasons" }],
    }));
    const wrapped = wrapAnthropic({ messages: { create } } as never);

    await (wrapped as { messages: { create: (p: unknown) => Promise<unknown> } }).messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 128,
      system: "be terse",
      messages: [{ role: "user", content: "why observability?" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const { trace, spans } = lastTrace();
    const llm = spans.find((s) => s.type === "llm")!;
    expect((llm.input_data as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "why observability?" },
    ]);
    expect((llm.input_data as { system: string }).system).toBe("be terse");
    expect(llm.output_data).toEqual({ content: "three reasons" });
    expect(trace).toBeDefined();
    expect(
      (morse._getLastTraceForTesting() as unknown as { resource?: Record<string, unknown> })
        .resource,
    ).toMatchObject({ "morse_ai.framework": "anthropic" });
  });
});

describe("openai adapter — input_data/output_data + framework", () => {
  it("captures both, and stamps morse_ai.framework on the trace resource", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    const create = vi.fn(async () => ({
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ message: { role: "assistant", content: "three reasons" } }],
    }));
    const wrapped = wrapOpenAI({
      chat: { completions: { create } },
    } as unknown as OpenAiClientLike);

    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "why observability?" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const { spans } = lastTrace();
    const llm = spans.find((s) => s.type === "llm")!;
    expect((llm.input_data as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "why observability?" },
    ]);
    expect(llm.output_data).toEqual({ content: "three reasons" });
    expect(
      (morse._getLastTraceForTesting() as unknown as { resource?: Record<string, unknown> })
        .resource,
    ).toMatchObject({ "morse_ai.framework": "openai" });
  });
});

describe("trace resource", () => {
  it("omits the resource entirely when no framework and no source are set", async () => {
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret
    await morse.runTraced({ agentName: "plain" }, async () => null);
    const entry = morse._getLastTraceForTesting() as unknown as {
      resource?: Record<string, unknown>;
    };
    // Absence is the signal — never invent a default framework.
    expect(entry.resource).toBeUndefined();
  });
});
