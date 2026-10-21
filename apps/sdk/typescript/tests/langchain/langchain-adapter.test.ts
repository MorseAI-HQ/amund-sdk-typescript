/**
 * Tests for `src/langchain/callback-handler.ts` — the plain-LangChain
 * `MorseCallbackHandler` (chain/LLM/tool/retriever spans).
 *
 * Mirrors the case granularity of the Python adapter's
 * `apps/sdk/python/tests/test_langchain_adapter.py` file-for-file, adapted
 * to this SDK's `AsyncLocalStorage`-based trace context (no auto-trace
 * creation / parent-restoration cases — see `callback-handler.ts`'s
 * file-header deviation notes for why those don't have a TS analogue) plus
 * new coverage for the retriever callbacks (@beta), which the Python file
 * doesn't test even though `langchain.py` implements them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MorseCallbackHandler,
  getCallbackHandlerClass,
} from "../../src/langchain/callback-handler";
import { _resetForTesting, getLastTrace, runSync } from "../../src/_internal/tracing";

interface WireSpan {
  span_id?: string;
  parent_span_id?: string;
  type?: string;
  name?: string;
  status?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  input_data?: unknown;
  output_data?: unknown;
  error_message?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function lastSpans(): WireSpan[] {
  const last = getLastTrace();
  return (last?.spans as WireSpan[] | undefined) ?? [];
}

function mockLLMResult(
  text = "response text",
  tokens: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    generations: [[{ text }]],
    llmOutput: tokens,
  };
}

function chainSerialized(name = "MyChain"): Record<string, unknown> {
  return { id: ["langchain", "chains", name], name };
}

function llmSerialized(name = "FakeLLM"): Record<string, unknown> {
  return { id: ["langchain", "llms", name], name };
}

function toolSerialized(name = "my_tool"): Record<string, unknown> {
  return { id: ["langchain", "tools", name], name };
}

let runIdCounter = 0;
function newRunId(): string {
  runIdCounter += 1;
  return `run-${runIdCounter}`;
}

beforeEach(() => {
  _resetForTesting();
  runIdCounter = 0;
});

/* ------------------------------------------------------------------------ */
/*  Chain / LLM / tool spans                                                */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — chain spans", () => {
  it("creates an agent-typed span for chain start/end", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleChainStart(chainSerialized("TestChain"), { question: "hi" }, runId);
      handler.handleChainEnd({ answer: "hello" }, runId);
    });

    const spans = lastSpans();
    const agentSpans = spans.filter((s) => s.type === "agent" && s.name === "TestChain");
    expect(agentSpans).toHaveLength(1);
    const span = agentSpans[0]!;
    expect(span.status).toBe("completed");
    expect(span.input_data).toEqual({ question: "hi" });
    expect(span.output_data).toEqual({ answer: "hello" });
  });
});

describe("MorseCallbackHandler — llm spans", () => {
  it("captures model name and token usage", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();
    const llmResult = mockLLMResult("The answer is 42", {
      token_usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });

    runSync({ agentName: "test-agent" }, () => {
      handler.handleLLMStart(llmSerialized("FakeLLM"), ["What is the answer?"], runId, undefined, {
        invocation_params: { model_name: "gpt-4o" },
      });
      handler.handleLLMEnd(llmResult, runId);
    });

    const spans = lastSpans();
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    const s = llmSpans[0]!;
    expect(s.model).toBe("gpt-4o");
    expect(s.input_tokens).toBe(10);
    expect(s.output_tokens).toBe(20);
    expect(s.total_tokens).toBe(30);
    expect(s.status).toBe("completed");
  });
});

describe("MorseCallbackHandler — chat-model input/output capture (MHQ-1156)", () => {
  it("a chat-model llm span carries both input_data and output_data", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleChatModelStart(
        llmSerialized("ChatOpenAI"),
        [
          [
            { _getType: () => "system", content: "You are helpful" },
            { _getType: () => "human", content: "hello" },
          ],
        ],
        runId,
      );
      handler.handleLLMEnd(mockLLMResult("hi there"), runId);
    });

    const llm = lastSpans().find((s) => s.type === "llm")!;
    expect(llm.input_data).toEqual({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
      ],
    });
    expect(llm.output_data).toEqual({ text: "hi there" });
  });

  it("captured chat-model input/output go through the redaction path", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleChatModelStart(
        llmSerialized("ChatOpenAI"),
        [[{ _getType: () => "human", content: "my ssn is 123-45-6789" }]],
        runId,
      );
      handler.handleLLMEnd(mockLLMResult("noted 123-45-6789"), runId);
    });

    const llm = lastSpans().find((s) => s.type === "llm")!;
    const wire = JSON.stringify([llm.input_data, llm.output_data]);
    expect(wire).not.toContain("123-45-6789");
    expect(wire.match(/\[REDACTED:ssn\]/g)).toHaveLength(2);
  });
});

describe("MorseCallbackHandler — context_segments (MHQ-750)", () => {
  it("handleChatModelStart decomposes flattened messages into context_segments", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleChatModelStart(
        llmSerialized("ChatOpenAI"),
        [
          [
            { _getType: () => "system", content: "You are helpful" },
            { _getType: () => "human", content: "hello" },
          ],
        ],
        runId,
      );
      handler.handleLLMEnd(mockLLMResult(), runId);
    });

    const spans = lastSpans();
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    const segs = llmSpans[0]!.context_segments as
      | Array<{ source: string; content?: string }>
      | undefined;
    expect(segs).toBeDefined();
    expect(segs!.some((s) => s.source === "system_prompt" && s.content === "You are helpful")).toBe(
      true,
    );
    expect(segs!.some((s) => s.source === "current_input" && s.content === "hello")).toBe(true);
  });

  it("handleChatModelStart pulls bound tools from extraParams.invocation_params", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleChatModelStart(
        llmSerialized("ChatOpenAI"),
        [[{ _getType: () => "human", content: "what's the weather" }]],
        runId,
        undefined,
        { invocation_params: { tools: [{ type: "function", function: { name: "get_weather" } }] } },
      );
      handler.handleLLMEnd(mockLLMResult(), runId);
    });

    const spans = lastSpans();
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    const segs = llmSpans[0]!.context_segments as
      | Array<{ source: string; attrs?: Record<string, unknown> }>
      | undefined;
    const toolSeg = segs?.find((s) => s.source === "tool_descriptions");
    expect(toolSeg).toBeDefined();
    expect(toolSeg!.attrs?.tool_names).toContain("get_weather");
  });
});

describe("MorseCallbackHandler — tool spans", () => {
  it("captures input and output data", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleToolStart(toolSerialized("calculator"), "2+2", runId);
      handler.handleToolEnd("4", runId);
    });

    const spans = lastSpans();
    const toolSpans = spans.filter((s) => s.type === "tool");
    expect(toolSpans).toHaveLength(1);
    const s = toolSpans[0]!;
    expect(s.input_data).toEqual({ input: "2+2" });
    expect(s.output_data).toEqual({ output: "4" });
    expect(s.status).toBe("completed");
  });
});

/* ------------------------------------------------------------------------ */
/*  Error paths                                                             */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — error paths", () => {
  it("handleChainError closes span with failed status and error_message", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();
    const error = new Error("chain blew up");

    runSync({ agentName: "test-agent" }, () => {
      handler.handleChainStart(chainSerialized("BrokenChain"), {}, runId);
      handler.handleChainError(error, runId);
    });

    const spans = lastSpans();
    const failedSpans = spans.filter((s) => s.name === "BrokenChain");
    expect(failedSpans).toHaveLength(1);
    const s = failedSpans[0]!;
    expect(s.status).toBe("failed");
    expect(s.error_message).toContain("chain blew up");
  });

  it("handleToolError closes span with failed status", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();
    const error = new Error("tool crashed");

    runSync({ agentName: "test-agent" }, () => {
      handler.handleToolStart(toolSerialized("broken_tool"), "input", runId);
      handler.handleToolError(error, runId);
    });

    const spans = lastSpans();
    const toolSpans = spans.filter((s) => s.type === "tool");
    expect(toolSpans).toHaveLength(1);
    expect(toolSpans[0]!.status).toBe("failed");
    expect(toolSpans[0]!.error_message).toContain("tool crashed");
  });

  it("handleLLMError closes span with failed status", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();
    const error = new Error("LLM unavailable");

    runSync({ agentName: "test-agent" }, () => {
      handler.handleLLMStart(llmSerialized("FakeLLM"), ["prompt"], runId);
      handler.handleLLMError(error, runId);
    });

    const spans = lastSpans();
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    expect(llmSpans[0]!.status).toBe("failed");
  });
});

/* ------------------------------------------------------------------------ */
/*  No active trace — silent no-op (TS analogue of Python's auto-trace)     */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — no active trace", () => {
  it("silently no-ops (never throws) when there is no active trace", () => {
    const handler = new MorseCallbackHandler({ agentName: "auto-agent" });
    const runId = newRunId();

    expect(() => {
      handler.handleChainStart(chainSerialized("AutoChain"), { q: "auto?" }, runId);
      handler.handleChainEnd({ a: "yes" }, runId);
    }).not.toThrow();

    // No active trace means `startSpan` returns null — nothing recorded,
    // and critically, nothing thrown into the caller.
    const last = getLastTrace();
    expect(last).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/*  Nesting                                                                  */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — nested spans", () => {
  it("chain -> llm -> tool produces correct parent linkage", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const chainRunId = newRunId();
    const llmRunId = newRunId();
    const toolRunId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleChainStart(chainSerialized("OuterChain"), {}, chainRunId);
      handler.handleLLMStart(llmSerialized("FakeLLM"), ["prompt"], llmRunId);
      handler.handleLLMEnd(mockLLMResult(), llmRunId);
      handler.handleToolStart(toolSerialized("mytool"), "in", toolRunId);
      handler.handleToolEnd("out", toolRunId);
      handler.handleChainEnd({}, chainRunId);
    });

    const spans = lastSpans();
    const byName = new Map(spans.map((s) => [s.name, s]));
    expect(byName.has("OuterChain")).toBe(true);
    expect(byName.has("FakeLLM")).toBe(true);
    expect(byName.has("mytool")).toBe(true);

    const chainSpanId = byName.get("OuterChain")!.span_id;
    expect(byName.get("FakeLLM")!.parent_span_id).toBe(chainSpanId);
    expect(byName.get("mytool")!.parent_span_id).toBe(chainSpanId);
  });
});

/* ------------------------------------------------------------------------ */
/*  Graceful fallback + defensive input handling                            */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — graceful fallback", () => {
  it("can be instantiated without @langchain/core installed", () => {
    const h = new MorseCallbackHandler({ agentName: "fallback-test" });
    expect(h).toBeDefined();
    expect(h.agentName).toBe("fallback-test");
  });

  it("tolerates null/undefined serialized (LangChain passes this for some Runnable graphs)", () => {
    const handler = new MorseCallbackHandler({ agentName: "none-serialized-test" });
    const chainRunId = newRunId();
    const llmRunId = newRunId();
    const toolRunId = newRunId();

    runSync({ agentName: "none-serialized-test" }, () => {
      // @ts-expect-error — intentional null to exercise defensive handling
      handler.handleChainStart(null, { q: "hi" }, chainRunId);
      handler.handleChainEnd({ a: "ok" }, chainRunId);

      // @ts-expect-error — intentional null
      handler.handleLLMStart(null, ["prompt"], llmRunId);
      handler.handleLLMEnd(mockLLMResult("done"), llmRunId);

      // @ts-expect-error — intentional null
      handler.handleToolStart(null, "input", toolRunId);
      handler.handleToolEnd("output", toolRunId);
    });

    const spans = lastSpans();
    const names = new Set(spans.map((s) => s.name));
    expect(names.has("chain")).toBe(true);
    expect(names.has("llm")).toBe(true);
    expect(names.has("tool")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/*  AGE-240 port: usage + cost extraction across provider shapes            */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — usage extraction across provider shapes", () => {
  it("extracts LC v0.3 Anthropic usage from message.usage_metadata + response_metadata.model_name", () => {
    const handler = new MorseCallbackHandler({ agentName: "anthropic-usage-test" });
    const runId = newRunId();
    const result = {
      generations: [
        [
          {
            text: "hi",
            message: {
              usage_metadata: {
                input_tokens: 100,
                output_tokens: 50,
                total_tokens: 150,
                input_token_details: { cache_read: 0 },
              },
              response_metadata: { model_name: "claude-sonnet-4-5-20250929" },
            },
          },
        ],
      ],
    };

    runSync({ agentName: "anthropic-usage-test" }, () => {
      handler.handleLLMStart({ id: ["ChatAnthropic"] }, ["q"], runId);
      handler.handleLLMEnd(result, runId);
    });

    const spans = lastSpans();
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    const s = llmSpans[0]!;
    expect(s.input_tokens).toBe(100);
    expect(s.output_tokens).toBe(50);
    expect(s.total_tokens).toBe(150);
    expect(s.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("extracts legacy Anthropic usage from llmOutput.usage", () => {
    const handler = new MorseCallbackHandler({ agentName: "anthropic-legacy-test" });
    const runId = newRunId();
    const result = mockLLMResult("hi", { usage: { input_tokens: 10, output_tokens: 20 } });

    runSync({ agentName: "anthropic-legacy-test" }, () => {
      handler.handleLLMStart({ id: ["ChatAnthropic"] }, ["q"], runId);
      handler.handleLLMEnd(result, runId);
    });

    const llmSpans = lastSpans().filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    expect(llmSpans[0]!.input_tokens).toBe(10);
    expect(llmSpans[0]!.output_tokens).toBe(20);
  });

  it("extracts response_metadata.token_usage + chat content fallback (ChatOpenAI-compatible)", () => {
    const handler = new MorseCallbackHandler({ agentName: "openai-response-metadata-test" });
    const runId = newRunId();
    const result = {
      generations: [
        [
          {
            text: "",
            message: {
              usage_metadata: {},
              response_metadata: {
                model_name: "gpt-4o-mini-2024-07-18",
                token_usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
              },
              content: "chat content fallback",
            },
          },
        ],
      ],
    };

    runSync({ agentName: "openai-response-metadata-test" }, () => {
      handler.handleLLMStart({ id: ["ChatOpenAI"] }, ["q"], runId);
      handler.handleLLMEnd(result, runId);
    });

    const llmSpans = lastSpans().filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(1);
    const s = llmSpans[0]!;
    expect(s.input_tokens).toBe(12);
    expect(s.output_tokens).toBe(7);
    expect(s.total_tokens).toBe(19);
    expect(s.model).toBe("gpt-4o-mini-2024-07-18");
    expect(s.output_data).toEqual({ text: "chat content fallback" });
  });

  it("still handles OpenAI legacy llmOutput.token_usage shape", () => {
    const handler = new MorseCallbackHandler({ agentName: "openai-legacy-test" });
    const runId = newRunId();
    const result = mockLLMResult("hi", {
      token_usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });

    runSync({ agentName: "openai-legacy-test" }, () => {
      handler.handleLLMStart({ id: ["OpenAI"] }, ["q"], runId);
      handler.handleLLMEnd(result, runId);
    });

    const llmSpans = lastSpans().filter((s) => s.type === "llm");
    expect(llmSpans[0]!.input_tokens).toBe(10);
    expect(llmSpans[0]!.output_tokens).toBe(20);
    expect(llmSpans[0]!.total_tokens).toBe(30);
  });
});

/* ------------------------------------------------------------------------ */
/*  Retriever spans (@beta) — not covered by the Python test file, but      */
/*  `langchain.py` implements on_retriever_*, so exercise the TS port here. */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — retriever spans (@beta)", () => {
  it("handleRetrieverStart/End captures query, doc summaries, and sources", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleRetrieverStart(
        { id: ["langchain", "retrievers", "MyRetriever"] },
        "what is x?",
        runId,
      );
      handler.handleRetrieverEnd(
        [
          { pageContent: "a".repeat(300), metadata: { source: "doc1.txt", score: 0.9 } },
          { pageContent: "short", metadata: { source: "doc2.txt" } },
        ],
        runId,
      );
    });

    const spans = lastSpans();
    const retrieverSpans = spans.filter((s) => s.type === "retriever");
    expect(retrieverSpans).toHaveLength(1);
    const s = retrieverSpans[0]!;
    expect(s.name).toBe("MyRetriever");
    expect(s.input_data).toEqual({ query: "what is x?" });
    expect(s.status).toBe("completed");
    const output = s.output_data as Record<string, unknown>;
    expect(output.docs_count).toBe(2);
    expect(output.top_score).toBe(0.9);
    expect(output.sources).toEqual(["doc1.txt", "doc2.txt"]);
    const docs = output.documents as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(2);
    expect((docs[0]!.content_preview as string).length).toBe(200);
    // @spec: RAGQ-01 — ranked documents[] with full (<=2KB) content
    expect(docs.map((d) => d.rank)).toEqual([1, 2]);
    expect((docs[0]!.content as string).length).toBe(300);
    expect(docs[0]!.source).toBe("doc1.txt");
  });

  it("handleRetrieverError closes span as failed", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleRetrieverStart({ id: ["retrievers", "R"] }, "q", runId);
      handler.handleRetrieverError(new Error("index unavailable"), runId);
    });

    const spans = lastSpans().filter((s) => s.type === "retriever");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
    expect(spans[0]!.error_message).toContain("index unavailable");
  });

  it("falls back to 'retriever' name when id path is absent", () => {
    const handler = new MorseCallbackHandler({ agentName: "test-agent" });
    const runId = newRunId();

    runSync({ agentName: "test-agent" }, () => {
      handler.handleRetrieverStart({}, "q", runId);
      handler.handleRetrieverEnd([], runId);
    });

    const spans = lastSpans().filter((s) => s.type === "retriever");
    expect(spans[0]!.name).toBe("retriever");
    const output = spans[0]!.output_data as Record<string, unknown>;
    expect(output.docs_count).toBe(0);
    expect(output.top_score).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/*  getCallbackHandlerClass                                                  */
/* ------------------------------------------------------------------------ */

describe("getCallbackHandlerClass", () => {
  it("resolves to a constructor (falls back to duck-typed class when @langchain/core absent)", async () => {
    const Cls = await getCallbackHandlerClass();
    expect(typeof Cls).toBe("function");
    const instance = new Cls();
    expect(typeof instance.name).toBe("string");
    expect(typeof instance.handleChainStart).toBe("function");
    expect(typeof instance.handleLLMStart).toBe("function");
    expect(typeof instance.handleToolStart).toBe("function");
    expect(typeof instance.handleRetrieverStart).toBe("function");
  });
});

// AID-09: this suite pins the pre-0.8 naming (chains as `agent` spans). The default
// shape is covered in tests/agent-identity-*.test.ts.
beforeAll(() => {
  process.env.MORSE_AGENT_IDENTITY = "legacy";
});
afterAll(() => {
  delete process.env.MORSE_AGENT_IDENTITY;
});
