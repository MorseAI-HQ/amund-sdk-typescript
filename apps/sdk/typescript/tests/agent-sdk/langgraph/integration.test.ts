/**
 * W3-L integration tests for `src/langgraph/index.ts`.
 *
 * End-to-end exercises of the composed `MorseCallbackHandler`:
 *   - registers all four chain/llm/tool/streaming surfaces on a single
 *     instance,
 *   - emits the expected chain + llm + tool spans across the canonical
 *     happy path,
 *   - establishes parent_span_id linkage via the shared span stack
 *     (chain → llm and chain → tool),
 *   - nests parent/child chains correctly,
 *   - aggregates streaming tokens onto a single llm span (no per-token
 *     spans),
 *   - keeps multi-instance state isolated.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MorseCallbackHandler } from "../../../src/langgraph/index";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

import {
  replayHappyPath,
  replayNestedChains,
  replayStreamingTokens,
} from "./fixtures/fake-callback-events";

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
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function lastSpans(): WireSpan[] {
  const last = getLastTrace();
  return (last?.spans as WireSpan[] | undefined) ?? [];
}

function adapterSpans(): WireSpan[] {
  return lastSpans().filter((s) => s.metadata?.adapter === "langgraph-js");
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Surface                                                                  */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler (composed) — surface", () => {
  it("exposes the full BaseCallbackHandler method surface on the instance", () => {
    const h = new MorseCallbackHandler();
    expect(typeof h.name).toBe("string");
    expect(typeof h.handleChainStart).toBe("function");
    expect(typeof h.handleChainEnd).toBe("function");
    expect(typeof h.handleChainError).toBe("function");
    expect(typeof h.handleLLMStart).toBe("function");
    expect(typeof h.handleChatModelStart).toBe("function");
    expect(typeof h.handleLLMEnd).toBe("function");
    expect(typeof h.handleLLMError).toBe("function");
    expect(typeof h.handleToolStart).toBe("function");
    expect(typeof h.handleToolEnd).toBe("function");
    expect(typeof h.handleToolError).toBe("function");
    expect(typeof h.handleLLMNewToken).toBe("function");
  });
});

/* ------------------------------------------------------------------------ */
/*  Happy path: chain + llm + tool spans with parent linkage                 */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler (composed) — happy path", () => {
  it("emits 1 chain + 1 llm + 1 tool span on the canonical happy path", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayHappyPath(handler);
    });
    const spans = adapterSpans();
    const chains = spans.filter((s) => s.type === "agent");
    const llms = spans.filter((s) => s.type === "llm");
    const tools = spans.filter((s) => s.type === "tool");
    expect(chains.length).toBe(1);
    expect(llms.length).toBe(1);
    expect(tools.length).toBe(1);

    const chain = chains[0]!;
    const llm = llms[0]!;
    const tool = tools[0]!;
    expect(chain.metadata?.adapter).toBe("langgraph-js");
    expect(llm.metadata?.adapter).toBe("langgraph-js");
    expect(tool.metadata?.adapter).toBe("langgraph-js");
    expect(chain.status).toBe("completed");
    expect(llm.status).toBe("completed");
    expect(tool.status).toBe("completed");
  });

  it("captures token usage from llmOutput.tokenUsage on the llm span", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayHappyPath(handler);
    });
    const llm = adapterSpans().find((s) => s.type === "llm")!;
    expect(llm.input_tokens).toBe(12);
    expect(llm.output_tokens).toBe(7);
    expect(llm.total_tokens).toBe(19);
  });

  it("captures tool input + output summaries on the tool span", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayHappyPath(handler);
    });
    const tool = adapterSpans().find((s) => s.type === "tool")!;
    expect(tool.metadata?.success).toBe(true);
    expect(tool.metadata?.tool_output_summary).toBeDefined();
  });

  it("links llm + tool spans under the chain span via parent_span_id", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayHappyPath(handler);
    });
    const spans = adapterSpans();
    const chain = spans.find((s) => s.type === "agent")!;
    const llm = spans.find((s) => s.type === "llm")!;
    const tool = spans.find((s) => s.type === "tool")!;
    expect(chain.span_id).toBeTruthy();
    expect(llm.parent_span_id).toBe(chain.span_id);
    expect(tool.parent_span_id).toBe(chain.span_id);
  });
});

/* ------------------------------------------------------------------------ */
/*  Nested chains                                                            */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler (composed) — nested chains", () => {
  it("emits 2 chain spans with child.parent_span_id === parent.span_id", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayNestedChains(handler);
    });
    const spans = adapterSpans();
    expect(spans.length).toBe(2);
    const parent = spans.find((s) => s.metadata?.agent_name === "parent");
    const child = spans.find((s) => s.metadata?.agent_name === "child");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.parent_span_id).toBe(parent!.span_id);
  });
});

/* ------------------------------------------------------------------------ */
/*  Streaming tokens                                                         */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler (composed) — streaming tokens", () => {
  it("aggregates 50 streamed tokens onto a single llm span (NO per-token spans)", async () => {
    const N = 50;
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayStreamingTokens(handler, N);
    });
    const spans = adapterSpans();
    const chains = spans.filter((s) => s.type === "agent");
    const llms = spans.filter((s) => s.type === "llm");
    expect(chains.length).toBe(1);
    expect(llms.length).toBe(1);
    const llm = llms[0]!;
    expect(llm.metadata?.tokens_streamed).toBe(N);
  });
});

/* ------------------------------------------------------------------------ */
/*  Multi-instance state isolation                                           */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler (composed) — state isolation", () => {
  it("two handler instances do not share llm/tool/chain state", async () => {
    // First handler: full happy path. Second handler in a fresh trace:
    // streaming run. Each instance must drive only its own spans.
    await runAsync({ agentName: "outer-1" }, async () => {
      const a = new MorseCallbackHandler();
      await replayHappyPath(a);
    });
    const firstSpans = adapterSpans();
    expect(firstSpans.filter((s) => s.type === "llm").length).toBe(1);
    expect(firstSpans.filter((s) => s.type === "tool").length).toBe(1);

    _resetForTesting();

    await runAsync({ agentName: "outer-2" }, async () => {
      const b = new MorseCallbackHandler();
      await replayStreamingTokens(b, 5);
    });
    const secondSpans = adapterSpans();
    expect(secondSpans.filter((s) => s.type === "llm").length).toBe(1);
    expect(secondSpans.filter((s) => s.type === "tool").length).toBe(0);
    const llm = secondSpans.find((s) => s.type === "llm")!;
    expect(llm.metadata?.tokens_streamed).toBe(5);
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
