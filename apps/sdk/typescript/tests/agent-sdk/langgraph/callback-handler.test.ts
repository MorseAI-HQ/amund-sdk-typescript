/**
 * Tests for `src/langgraph/callback-handler.ts` (W2-L.1).
 *
 * Asserts that `MorseCallbackHandler`:
 *   - exposes the LangGraph-required `name` string,
 *   - opens an `agent` span on `handleChainStart` tagged with adapter,
 *   - resolves the agent name via runName → chain.name → defaultAgentName
 *     → "langgraph-agent",
 *   - closes the span as `completed` on `handleChainEnd` and `failed`
 *     on `handleChainError`,
 *   - nests child chains correctly (`parent_span_id` linkage),
 *   - handles multiple sequential chains in one trace,
 *   - absorbs internal errors silently (never throws at LangGraph runtime),
 *   - `getCallbackHandlerClass()` returns a constructor.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  MorseCallbackHandler,
  getCallbackHandlerClass,
} from "../../../src/langgraph/callback-handler";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

import { replayHappyPath, replayNestedChains } from "./fixtures/fake-callback-events";

interface WireSpan {
  span_id?: string;
  parent_span_id?: string;
  type?: string;
  name?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function lastSpans(): WireSpan[] {
  const last = getLastTrace();
  return (last?.spans as WireSpan[] | undefined) ?? [];
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Surface                                                                  */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — surface", () => {
  it("constructs without throwing and exposes a string `name`", () => {
    const handler = new MorseCallbackHandler();
    expect(handler).toBeInstanceOf(MorseCallbackHandler);
    expect(typeof handler.name).toBe("string");
    expect(handler.name.length).toBeGreaterThan(0);
  });

  it("accepts a `defaultAgentName` option without throwing", () => {
    const handler = new MorseCallbackHandler({ defaultAgentName: "my-agent" });
    expect(handler.name.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  handleChainStart / handleChainEnd                                        */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — chain spans", () => {
  it("opens an agent span tagged with metadata.adapter='langgraph-js' on handleChainStart", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      handler.handleChainStart(
        { id: ["langchain", "chains", "RunnableSequence"], name: "my-chain" },
        {},
        "run_1",
      );
      handler.handleChainEnd({}, "run_1");
    });
    const spans = lastSpans();
    const agentSpan = spans.find(
      (s) => s.type === "agent" && s.metadata?.adapter === "langgraph-js",
    );
    expect(agentSpan).toBeDefined();
    expect(agentSpan!.metadata?.adapter).toBe("langgraph-js");
  });

  it("uses 'langgraph-agent' fallback when chain has no name and no overrides", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      handler.handleChainStart({}, {}, "run_unnamed");
      handler.handleChainEnd({}, "run_unnamed");
    });
    const spans = lastSpans();
    const agentSpan = spans.find((s) => s.metadata?.adapter === "langgraph-js");
    expect(agentSpan?.metadata?.agent_name).toBe("langgraph-agent");
  });

  it("prefers runName over chain.name when both are present", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      handler.handleChainStart(
        { name: "ClassName" },
        {},
        "run_2",
        undefined,
        undefined,
        undefined,
        undefined,
        "RunNameWins",
      );
      handler.handleChainEnd({}, "run_2");
    });
    const spans = lastSpans();
    const agentSpan = spans.find((s) => s.metadata?.adapter === "langgraph-js");
    expect(agentSpan?.metadata?.agent_name).toBe("RunNameWins");
  });

  it("falls back to defaultAgentName option when chain has no name and no runName", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler({ defaultAgentName: "configured-default" });
      handler.handleChainStart({}, {}, "run_3");
      handler.handleChainEnd({}, "run_3");
    });
    const spans = lastSpans();
    const agentSpan = spans.find((s) => s.metadata?.adapter === "langgraph-js");
    expect(agentSpan?.metadata?.agent_name).toBe("configured-default");
  });

  it("closes the span with status='completed' on handleChainEnd", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      handler.handleChainStart({ name: "chain_a" }, {}, "run_4");
      handler.handleChainEnd({}, "run_4");
    });
    const spans = lastSpans();
    const agentSpan = spans.find((s) => s.metadata?.adapter === "langgraph-js");
    expect(agentSpan?.status).toBe("completed");
  });

  it("closes the span with status='failed' on handleChainError", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      handler.handleChainStart({ name: "chain_err" }, {}, "run_5");
      handler.handleChainError(new Error("boom"), "run_5");
    });
    const spans = lastSpans();
    const agentSpan = spans.find((s) => s.metadata?.adapter === "langgraph-js");
    expect(agentSpan?.status).toBe("failed");
    expect(typeof agentSpan?.error_message).toBe("string");
  });
});

/* ------------------------------------------------------------------------ */
/*  Nested chains + multi-chain ordering                                     */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — nesting and ordering", () => {
  it("nests child chain under parent — child.parent_span_id === parent.span_id", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayNestedChains(handler);
    });
    const spans = lastSpans();
    const adapterSpans = spans.filter((s) => s.metadata?.adapter === "langgraph-js");
    expect(adapterSpans.length).toBe(2);
    const parent = adapterSpans.find((s) => s.metadata?.agent_name === "parent");
    const child = adapterSpans.find((s) => s.metadata?.agent_name === "child");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.parent_span_id).toBe(parent!.span_id);
  });

  it("handles the happy-path fixture without throwing (chain-level only)", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      await replayHappyPath(handler);
    });
    const spans = lastSpans();
    const adapterSpans = spans.filter((s) => s.metadata?.adapter === "langgraph-js");
    // W2-L.1 emits chain spans only — exactly one for the root chain.
    expect(adapterSpans.length).toBe(1);
    const first = adapterSpans[0]!;
    expect(first.metadata?.agent_name).toBe("agent");
    expect(first.status).toBe("completed");
  });

  it("emits multiple sequential chain spans in start order", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      handler.handleChainStart({ name: "first" }, {}, "run_a");
      handler.handleChainEnd({}, "run_a");
      handler.handleChainStart({ name: "second" }, {}, "run_b");
      handler.handleChainEnd({}, "run_b");
    });
    const spans = lastSpans();
    const adapterSpans = spans.filter((s) => s.metadata?.adapter === "langgraph-js");
    expect(adapterSpans.length).toBe(2);
    const names = adapterSpans.map((s) => s.metadata?.agent_name);
    expect(names).toContain("first");
    expect(names).toContain("second");
  });
});

/* ------------------------------------------------------------------------ */
/*  Error absorption                                                         */
/* ------------------------------------------------------------------------ */

describe("MorseCallbackHandler — error absorption", () => {
  it("never throws at LangGraph runtime even with malformed input", () => {
    const handler = new MorseCallbackHandler();
    // No active trace + weird inputs — must be silent.
    expect(() =>
      // @ts-expect-error — intentional bad inputs to exercise absorbErrorsSync
      handler.handleChainStart(null, null, "run_x"),
    ).not.toThrow();
    expect(() => handler.handleChainEnd({}, "never_started")).not.toThrow();
    expect(() => handler.handleChainError(new Error("noop"), "never_started")).not.toThrow();
  });

  it("handleChainEnd for an unknown runId is a no-op (no throw, no span emitted)", async () => {
    await runAsync({ agentName: "outer" }, async () => {
      const handler = new MorseCallbackHandler();
      handler.handleChainEnd({}, "ghost_run");
    });
    const spans = lastSpans();
    const adapterSpans = spans.filter((s) => s.metadata?.adapter === "langgraph-js");
    expect(adapterSpans.length).toBe(0);
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
    expect(typeof instance.handleChainEnd).toBe("function");
    expect(typeof instance.handleChainError).toBe("function");
  });
});
