/**
 * Tests for `src/langgraph/llm-and-tool-callbacks.ts` — Wave 2-L.2.
 *
 * Drives the LLM + tool slice of the LangGraph callback handler against
 * the shared fake-callback-events fixture inside a real `runAsync` trace.
 * Asserts:
 *   - llm spans open/close with token usage from llmOutput.tokenUsage
 *   - chat model start also opens an llm span (chat models ARE LLMs)
 *   - tool spans capture summarized input + output, success/error
 *   - orphan end events are silently ignored
 *   - provider extracted from langchain_* id segments
 *   - happy path through the shared fixture emits the expected pair of spans
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  createLlmAndToolHandlers,
  type LangGraphRunState,
} from "../../../src/langgraph/llm-and-tool-callbacks";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";
import { replayHappyPath } from "./fixtures/fake-callback-events";

interface WireSpan {
  type: string;
  name: string;
  span_id?: string;
  parent_span_id?: string;
  status?: string;
  error_message?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function freshState(): LangGraphRunState {
  return {
    llmSpans: new Map(),
    toolSpans: new Map(),
    chainSpans: new Map(),
  };
}

/** Collect non-root spans emitted by `fn` inside a trace. */
async function captureSpans(fn: () => Promise<void>): Promise<WireSpan[]> {
  await runAsync({ agentName: "test-agent" }, async () => {
    await fn();
  });
  const last = getLastTrace();
  const all = (last?.spans ?? []) as WireSpan[];
  return all.filter((s) => s.name !== "test-agent");
}

beforeEach(() => {
  _resetForTesting();
});

describe("createLlmAndToolHandlers — shape", () => {
  it("returns an object exposing all seven method names", () => {
    const handlers = createLlmAndToolHandlers(freshState());
    expect(typeof handlers.handleLLMStart).toBe("function");
    expect(typeof handlers.handleChatModelStart).toBe("function");
    expect(typeof handlers.handleLLMEnd).toBe("function");
    expect(typeof handlers.handleLLMError).toBe("function");
    expect(typeof handlers.handleToolStart).toBe("function");
    expect(typeof handlers.handleToolEnd).toBe("function");
    expect(typeof handlers.handleToolError).toBe("function");
  });
});

describe("createLlmAndToolHandlers — input_data/output_data + framework (MHQ-858/859)", () => {
  it("chat model start captures messages as input_data and the reply as output_data", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleChatModelStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        [[{ _getType: () => "human", content: "Reply with the single word: pong." }]],
        "run-io",
      );
      await h.handleLLMEnd?.({ generations: [[{ text: "Pong." }]] }, "run-io");
    });
    const llm = spans.find((s) => s.type === "llm")!;
    expect((llm.input_data as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "Reply with the single word: pong." },
    ]);
    expect(llm.output_data).toEqual({ content: "Pong." });
  });

  it("raw-prompt LLM start captures prompts as input_data", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMStart?.({ id: ["langchain_openai", "OpenAI"] }, ["say hi"], "run-p");
      await h.handleLLMEnd?.({ generations: [[{ text: "hi" }]] }, "run-p");
    });
    const llm = spans.find((s) => s.type === "llm")!;
    expect((llm.input_data as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "say hi" },
    ]);
  });

  it("stamps morse_ai.framework=langgraph — the cross-language label, not langgraph-js", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    await runAsync({ agentName: "test-agent" }, async () => {
      await h.handleLLMStart?.({ id: ["langchain_openai", "OpenAI"] }, ["hi"], "run-f");
      await h.handleLLMEnd?.({}, "run-f");
    });
    const entry = getLastTrace() as unknown as { resource?: Record<string, unknown> };
    expect(entry.resource).toMatchObject({ "morse_ai.framework": "langgraph" });
  });
});

describe("createLlmAndToolHandlers — llm spans", () => {
  it("handleLLMStart opens an llm span with adapter + model + provider", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        ["hi"],
        "run-1",
      );
      await h.handleLLMEnd?.({}, "run-1");
    });
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("llm");
    expect(s.name).toBe("langgraph-js.llm");
    expect(s.model).toBe("ChatOpenAI");
    expect(s.metadata?.adapter).toBe("langgraph-js");
    expect(s.metadata?.provider).toBe("openai");
    expect(s.status).toBe("completed");
  });

  it("handleChatModelStart also opens an llm span", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleChatModelStart?.(
        { id: ["langchain_anthropic", "ChatAnthropic"], name: "ChatAnthropic" },
        [[{ content: "hello" }]],
        "run-2",
      );
      await h.handleLLMEnd?.({}, "run-2");
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.type).toBe("llm");
    expect(spans[0]!.model).toBe("ChatAnthropic");
    expect(spans[0]!.metadata?.provider).toBe("anthropic");
  });

  it("handleLLMEnd applies token usage from llmOutput.tokenUsage", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        ["hi"],
        "run-3",
      );
      await h.handleLLMEnd?.(
        {
          generations: [[{ text: "ok" }]],
          llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 } },
        },
        "run-3",
      );
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.input_tokens).toBe(11);
    expect(spans[0]!.output_tokens).toBe(4);
    expect(spans[0]!.total_tokens).toBe(15);
  });

  it("handleLLMEnd derives total_tokens when only prompt + completion present", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMStart?.({ name: "X" }, ["hi"], "run-4");
      await h.handleLLMEnd?.(
        { llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 7 } } },
        "run-4",
      );
    });
    expect(spans[0]!.total_tokens).toBe(10);
  });

  // MHQ-788: `llm.name` is the Serializable class name (e.g. "ChatOpenAI"),
  // never the real model — the real model lives in
  // `extraParams.invocation_params.model`, which every provider's chat
  // model populates before firing this callback.
  it("handleChatModelStart reads the real model from extraParams.invocation_params.model, not llm.name", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleChatModelStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        [[{ content: "hi" }]],
        "run-model-1",
        undefined,
        { invocation_params: { model: "gpt-4o-mini" } },
      );
      await h.handleLLMEnd?.(
        { llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } },
        "run-model-1",
      );
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.model).toBe("gpt-4o-mini");
    // Model + real tokens together should now also compute a real cost —
    // this was blocked before the fix because model stayed "unknown".
    expect(typeof spans[0]!.cost_usd).toBe("number");
    expect(spans[0]!.cost_usd as number).toBeGreaterThan(0);
  });

  it("handleChatModelStart falls back to llm.name when invocation_params has no model", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleChatModelStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        [[{ content: "hi" }]],
        "run-model-2",
        undefined,
        { invocation_params: {} },
      );
      await h.handleLLMEnd?.({}, "run-model-2");
    });
    expect(spans[0]!.model).toBe("ChatOpenAI");
  });

  it("handleLLMError closes the span as failed", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMStart?.({ name: "X" }, ["hi"], "run-5");
      await h.handleLLMError?.(new Error("boom"), "run-5");
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
    expect(spans[0]!.error_message).toContain("boom");
  });
});

describe("createLlmAndToolHandlers — tool spans", () => {
  it("handleToolStart opens a tool span with summarized input", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleToolStart?.(
        { id: ["langchain_core", "tools", "Tool"], name: "get_weather" },
        JSON.stringify({ city: "SF" }),
        "tool-1",
      );
      await h.handleToolEnd?.(JSON.stringify({ temp: 65 }), "tool-1");
    });
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("tool");
    expect(s.name).toBe("langgraph-js.tool.get_weather");
    const tool = s.metadata?.tool as Record<string, unknown> | undefined;
    expect(tool?.name).toBe("get_weather");
    expect(typeof tool?.input_summary).toBe("string");
    expect(s.metadata?.tool_output_summary).toBeDefined();
    expect(s.metadata?.success).toBe(true);
    expect(s.status).toBe("completed");
  });

  it("handleToolError closes the span as failed and marks success=false", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleToolStart?.({ name: "shell" }, "rm -rf /", "tool-2");
      await h.handleToolError?.(new Error("permission denied"), "tool-2");
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
    expect(spans[0]!.error_message).toContain("permission denied");
    expect(spans[0]!.metadata?.success).toBe(false);
  });

  it("falls back to 'unknown' when tool.name is missing", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleToolStart?.({}, "{}", "tool-3");
      await h.handleToolEnd?.("done", "tool-3");
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("langgraph-js.tool.unknown");
  });
});

describe("createLlmAndToolHandlers — robustness", () => {
  it("matches multiple concurrent llm calls by runId", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMStart?.({ name: "M1" }, ["a"], "rA");
      await h.handleLLMStart?.({ name: "M2" }, ["b"], "rB");
      await h.handleLLMEnd?.(
        { llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } },
        "rB",
      );
      await h.handleLLMEnd?.(
        { llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 } } },
        "rA",
      );
    });
    expect(spans).toHaveLength(2);
    const byModel = new Map(spans.map((s) => [s.model, s]));
    expect(byModel.get("M1")?.total_tokens).toBe(11);
    expect(byModel.get("M2")?.total_tokens).toBe(2);
  });

  it("orphan handleLLMEnd (no preceding start) is a no-op", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMEnd?.(
        { llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } },
        "orphan",
      );
    });
    expect(spans).toHaveLength(0);
    expect(state.llmSpans.size).toBe(0);
  });

  it("orphan handleToolEnd is a no-op", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleToolEnd?.("output", "orphan-tool");
    });
    expect(spans).toHaveLength(0);
    expect(state.toolSpans.size).toBe(0);
  });

  it("extracts provider from langchain_* prefix and returns first segment otherwise", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleLLMStart?.(
        { id: ["custom_provider", "Whatever"], name: "ZZZ" },
        ["hi"],
        "r-prov",
      );
      await h.handleLLMEnd?.({}, "r-prov");
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.metadata?.provider).toBe("custom_provider");
  });

  it("replayHappyPath emits one llm span + one tool span", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    // Compose just our slice into a CallbackHandlerSurface-shaped stub.
    // chain handlers are no-ops here — that's W2-L.1's territory.
    const stub = {
      handleLLMStart: h.handleLLMStart,
      handleChatModelStart: h.handleChatModelStart,
      handleLLMEnd: h.handleLLMEnd,
      handleLLMError: h.handleLLMError,
      handleToolStart: h.handleToolStart,
      handleToolEnd: h.handleToolEnd,
      handleToolError: h.handleToolError,
    };

    const spans = await captureSpans(async () => {
      await replayHappyPath(stub);
    });
    const llm = spans.filter((s) => s.type === "llm");
    const tool = spans.filter((s) => s.type === "tool");
    expect(llm).toHaveLength(1);
    expect(tool).toHaveLength(1);
    expect(llm[0]!.model).toBe("ChatOpenAI");
    expect(llm[0]!.input_tokens).toBe(12);
    expect(llm[0]!.output_tokens).toBe(7);
    expect(llm[0]!.total_tokens).toBe(19);
    expect(tool[0]!.name).toBe("langgraph-js.tool.get_weather");
    expect(tool[0]!.metadata?.success).toBe(true);
    // After replay the maps should be empty (no leaked spans).
    expect(state.llmSpans.size).toBe(0);
    expect(state.toolSpans.size).toBe(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  MHQ-750 — context_segments on handleChatModelStart                       */
/* ------------------------------------------------------------------------ */

describe("createLlmAndToolHandlers — context_segments (MHQ-750)", () => {
  it("handleChatModelStart decomposes flattened messages into context_segments", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleChatModelStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        [
          [
            { _getType: () => "system", content: "You are helpful" },
            { _getType: () => "human", content: "hello" },
          ],
        ],
        "run-ctx",
      );
      await h.handleLLMEnd?.({}, "run-ctx");
    });
    expect(spans).toHaveLength(1);
    const segs = spans[0]!.context_segments as
      | Array<{ source: string; content?: string }>
      | undefined;
    expect(segs).toBeDefined();
    expect(segs!.some((s) => s.source === "system_prompt" && s.content === "You are helpful")).toBe(
      true,
    );
    expect(segs!.some((s) => s.source === "current_input" && s.content === "hello")).toBe(true);
  });

  it("handleChatModelStart pulls bound tools from extra.invocation_params", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleChatModelStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        [[{ _getType: () => "human", content: "what's the weather" }]],
        "run-ctx-tools",
        undefined,
        { invocation_params: { tools: [{ type: "function", function: { name: "get_weather" } }] } },
      );
      await h.handleLLMEnd?.({}, "run-ctx-tools");
    });
    const segs = spans[0]!.context_segments as
      | Array<{ source: string; attrs?: Record<string, unknown> }>
      | undefined;
    expect(segs).toBeDefined();
    const toolSeg = segs!.find((s) => s.source === "tool_descriptions");
    expect(toolSeg).toBeDefined();
    expect(toolSeg!.attrs?.tool_names).toContain("get_weather");
  });

  it("does not set context_segments when messages produce none", async () => {
    const state = freshState();
    const h = createLlmAndToolHandlers(state);
    const spans = await captureSpans(async () => {
      await h.handleChatModelStart?.(
        { id: ["langchain_openai", "ChatOpenAI"], name: "ChatOpenAI" },
        [],
        "run-ctx-empty",
      );
      await h.handleLLMEnd?.({}, "run-ctx-empty");
    });
    expect(spans[0]!.context_segments).toBeUndefined();
  });
});
