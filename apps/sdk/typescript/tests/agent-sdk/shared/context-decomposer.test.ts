/**
 * Tests for `_agent-sdk-common/context-decomposer.ts` (MHQ-750).
 *
 * Mirrors `apps/sdk/python/tests/test_context_decomposer.py`'s coverage —
 * `decomposeOpenAiMessages` is a pure function, exercised directly without
 * any active trace / transport.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONTEXT_SEGMENT_CONTENT_BYTE_CAP,
  decomposeOpenAiMessages,
} from "../../../src/_agent-sdk-common/context-decomposer";
import type { ContextSegment } from "../../../src/_internal/spans";

function sha(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function bySource(segs: ContextSegment[], source: string): ContextSegment[] {
  return segs.filter((s) => s.source === source);
}

/* ------------------------------------------------------------------------ */
/*  Basic happy-path tests                                                   */
/* ------------------------------------------------------------------------ */

describe("decomposeOpenAiMessages", () => {
  it("basic user message emits current_input", () => {
    const segs = decomposeOpenAiMessages([{ role: "user", content: "hello" }]);
    const inputs = bySource(segs, "current_input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.content).toBe("hello");
    expect(inputs[0]!.tokens).toBeUndefined();
    expect(inputs[0]!.content_hash).toBe(sha("hello"));
  });

  it("system message emits system_prompt", () => {
    const segs = decomposeOpenAiMessages([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hi" },
    ]);
    const sysSegs = bySource(segs, "system_prompt");
    expect(sysSegs).toHaveLength(1);
    expect(sysSegs[0]!.content).toBe("You are helpful");
  });

  it("tool definitions emitted first", () => {
    const tools = [
      { type: "function", function: { name: "get_weather", description: "get weather" } },
    ];
    const segs = decomposeOpenAiMessages(
      [{ role: "user", content: "what is the weather?" }],
      tools,
    );
    expect(segs[0]!.source).toBe("tool_descriptions");
    expect(segs[0]!.attrs?.tool_count).toBe(1);
    expect(segs[0]!.attrs?.tool_names).toContain("get_weather");
  });

  it("tool definitions include tool names", () => {
    const tools = [
      { type: "function", function: { name: "search" } },
      { type: "function", function: { name: "summarize" } },
    ];
    const segs = decomposeOpenAiMessages([{ role: "user", content: "go" }], tools);
    const td = bySource(segs, "tool_descriptions");
    expect(td).toHaveLength(1);
    expect(new Set(td[0]!.attrs?.tool_names as string[])).toEqual(new Set(["search", "summarize"]));
  });

  it("prior turns are chat_history", () => {
    const segs = decomposeOpenAiMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: "okay" },
      { role: "user", content: "second" },
    ]);
    const history = bySource(segs, "chat_history");
    const current = bySource(segs, "current_input");
    expect(history).toHaveLength(2);
    expect(current).toHaveLength(1);
    expect(current[0]!.content).toBe("second");
  });

  it("tool role emits tool_observation", () => {
    const segs = decomposeOpenAiMessages([
      { role: "user", content: "search something" },
      { role: "assistant", content: null },
      { role: "tool", content: "result data", tool_call_id: "call_abc" },
      { role: "user", content: "now summarize" },
    ]);
    const obs = bySource(segs, "tool_observation");
    expect(obs).toHaveLength(1);
    expect(obs[0]!.content).toContain("result data");
    expect(obs[0]!.content).toContain("call_abc");
  });

  it("position ordering is sequential", () => {
    const tools = [{ type: "function", function: { name: "f" } }];
    const segs = decomposeOpenAiMessages(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "prior" },
        { role: "assistant", content: "resp" },
        { role: "user", content: "now" },
      ],
      tools,
    );
    const positions = segs.map((s) => s.position);
    expect(positions).toEqual(segs.map((_, i) => i));
  });

  it("emission order: tools -> system -> history -> input", () => {
    const tools = [{ type: "function", function: { name: "f" } }];
    const segs = decomposeOpenAiMessages(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "assistant", content: "resp" },
        { role: "user", content: "current" },
      ],
      tools,
    );
    const sources = segs.map((s) => s.source);
    expect(sources[0]).toBe("tool_descriptions");
    expect(sources[1]).toBe("system_prompt");
    expect(sources[sources.length - 1]).toBe("current_input");
    expect(sources.slice(2, -1).every((s) => s === "chat_history")).toBe(true);
  });

  it("content list parts are joined (OpenAI vision format)", () => {
    const segs = decomposeOpenAiMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "..." } },
        ],
      },
    ]);
    const current = bySource(segs, "current_input");
    expect(current).toHaveLength(1);
    expect(current[0]!.content).toContain("describe this");
    expect(current[0]!.content).toContain("[image]");
  });

  it("long content is truncated; content_hash covers full original text", () => {
    const big = "x".repeat(5000);
    const segs = decomposeOpenAiMessages([{ role: "user", content: big }]);
    expect(segs).toHaveLength(1);
    const seg = segs[0]!;
    expect(seg.content_truncated).toBe(true);
    expect(Buffer.byteLength(seg.content ?? "", "utf-8")).toBeLessThanOrEqual(
      CONTEXT_SEGMENT_CONTENT_BYTE_CAP,
    );
    expect(seg.content_hash).toBe(sha(big));
  });

  it("empty messages returns empty", () => {
    expect(decomposeOpenAiMessages([])).toEqual([]);
    expect(decomposeOpenAiMessages(undefined)).toEqual([]);
    expect(decomposeOpenAiMessages(null)).toEqual([]);
  });

  it("no tools means no tool_descriptions segment", () => {
    const segs = decomposeOpenAiMessages([{ role: "user", content: "hi" }], undefined);
    expect(bySource(segs, "tool_descriptions")).toHaveLength(0);
  });

  it("malformed input returns empty, never throws", () => {
    expect(decomposeOpenAiMessages("not a list")).toEqual([]);
    expect(decomposeOpenAiMessages([{ role: null }])).toEqual([]);
    expect(() => decomposeOpenAiMessages(42)).not.toThrow();
  });

  it("tools-only decomposition works even without a messages array", () => {
    const tools = [{ type: "function", function: { name: "f" } }];
    const segs = decomposeOpenAiMessages(undefined, tools);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.source).toBe("tool_descriptions");
  });

  /* ------------------------------------------------------------------------ */
  /*  LangChain-style message duck-typing                                     */
  /* ------------------------------------------------------------------------ */

  it("decomposes LangChain-style messages via _getType()", () => {
    const fakeSystem = { _getType: () => "system", content: "You are a math teacher" };
    const fakeHuman = { _getType: () => "human", content: "what is 2+2" };
    const segs = decomposeOpenAiMessages([fakeSystem, fakeHuman]);
    const sysSegs = bySource(segs, "system_prompt");
    const inputSegs = bySource(segs, "current_input");
    expect(sysSegs).toHaveLength(1);
    expect(inputSegs).toHaveLength(1);
    expect(sysSegs[0]!.content).toBe("You are a math teacher");
    expect(inputSegs[0]!.content).toBe("what is 2+2");
  });

  it("decomposes LangChain-style messages via .type string", () => {
    const fakeSystem = { type: "system", content: "sys" };
    const fakeHuman = { type: "human", content: "hi" };
    const segs = decomposeOpenAiMessages([fakeSystem, fakeHuman]);
    expect(bySource(segs, "system_prompt")).toHaveLength(1);
    expect(bySource(segs, "current_input")).toHaveLength(1);
  });

  it("LangChain-style tool message emits tool_observation", () => {
    const fakeToolMsg = {
      _getType: () => "tool",
      content: "search result",
      tool_call_id: "call_xyz",
    };
    const fakeHuman = { _getType: () => "human", content: "summarize" };
    const segs = decomposeOpenAiMessages([fakeToolMsg, fakeHuman]);
    const obs = bySource(segs, "tool_observation");
    expect(obs).toHaveLength(1);
    expect(obs[0]!.content).toContain("search result");
  });
});
