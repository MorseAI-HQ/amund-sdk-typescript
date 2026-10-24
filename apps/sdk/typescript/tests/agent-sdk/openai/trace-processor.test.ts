/**
 * Unit tests for `MorseTraceProcessor`.
 *
 * Drives the processor with mock OpenAI Agents SDK span objects inside a
 * `runAsync` trace and asserts the emitted Morse spans match. No
 * dependency on `@openai/agents` itself — the processor's input is a
 * structural type so we can construct spans directly in TS.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MorseTraceProcessor,
  type OpenAISpanLike,
} from "../../../src/openai-agents/trace-processor";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

interface WireSpan {
  type: string;
  name: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  // Added by #480 alongside the cost assertions below, but not here — so
  // `pnpm --filter @morsehq/sdk type-check` has been failing on develop ever
  // since, and that command gates the npm publish job.
  cost_usd?: number;
  status?: string;
  metadata?: Record<string, unknown>;
}

function spansFromLast(): WireSpan[] {
  const last = getLastTrace();
  return (last?.spans ?? []) as WireSpan[];
}

/** Filter out the root agent span opened by `runAsync({ agentName: "t" })`. */
function adapterSpans(): WireSpan[] {
  return spansFromLast().filter((s) => s.name !== "t");
}

/** Helper to build an OpenAI span with a stable spanId. */
function span(
  id: string,
  type: string,
  name?: string,
  rest?: Record<string, unknown>,
): OpenAISpanLike {
  return {
    spanId: id,
    spanData: {
      type,
      name,
      ...rest,
    },
  };
}

beforeEach(() => {
  _resetForTesting();
});

describe("MorseTraceProcessor — basic span translation", () => {
  it("translates an `agent` span into a type=agent Morse span", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_1", "agent", "triage_agent");
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const spans = adapterSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.type).toBe("agent");
    expect(spans[0]!.metadata?.adapter).toBe("openai-agents");
  });

  it("translates a `response` span into a type=llm Morse span with model + usage", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_2", "response", "completion", {
        model: "gpt-4o-mini",
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
      });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const llm = adapterSpans().find((x) => x.type === "llm");
    expect(llm).toBeDefined();
    expect(llm!.model).toBe("gpt-4o-mini");
    expect(llm!.input_tokens).toBe(50);
    expect(llm!.output_tokens).toBe(20);
    expect(llm!.total_tokens).toBe(70);
  });

  it("translates a `generation` span the same way as `response`", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_3", "generation", "gen", {
        model: "gpt-4o",
        usage: { prompt_tokens: 30, completion_tokens: 15 }, // alt naming
      });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const llm = adapterSpans().find((x) => x.type === "llm");
    expect(llm).toBeDefined();
    expect(llm!.input_tokens).toBe(30);
    expect(llm!.output_tokens).toBe(15);
    expect(llm!.total_tokens).toBe(45); // computed from prompt+completion
  });

  it("translates a `function` span into a type=tool Morse span", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_4", "function", "get_weather", {
        input: { city: "SF" },
        output: { temp: 65 },
      });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const tool = adapterSpans().find((x) => x.type === "tool");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("openai-agents.tool.get_weather");
    expect(tool!.metadata?.tool_output_summary).toBeDefined();
  });

  it("translates a `handoff` span into a subagent.spawn-shaped (type=agent) span", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_5", "handoff", undefined, {
        from_agent: "triage",
        to_agent: "seat_booking",
        reason: "user asked to change seat",
      });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const spans = adapterSpans();
    const handoff = spans.find((x) => x.metadata?.spawn_kind === "subagent");
    expect(handoff).toBeDefined();
    expect(handoff!.type).toBe("agent");
    expect(handoff!.metadata?.parent_agent_name).toBe("triage");
    expect(handoff!.metadata?.subagent_name).toBe("seat_booking");
  });

  it("translates a `guardrail` span (passed) into a type=tool with tool_kind=guardrail", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_6", "guardrail", "pii_filter", { passed: true });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const spans = adapterSpans();
    const g = spans.find((x) => x.metadata?.tool_kind === "guardrail");
    expect(g).toBeDefined();
    expect(g!.status).toBe("completed");
    const meta = g!.metadata as { guardrail?: { passed?: boolean; name?: string } };
    expect(meta.guardrail?.passed).toBe(true);
    expect(meta.guardrail?.name).toBe("pii_filter");
  });

  it("translates a failed guardrail into a failed span with reason in metadata", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_7", "guardrail", "pii_filter", {
        passed: false,
        reason: "ssn detected",
      });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const g = adapterSpans().find((x) => x.metadata?.tool_kind === "guardrail");
    expect(g!.status).toBe("failed");
    const meta = g!.metadata as { guardrail?: { reason?: string } };
    expect(meta.guardrail?.reason).toBe("ssn detected");
  });

  it("translates `mcp_list_tools` into a type=tool span", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_8", "mcp_list_tools", "my_mcp");
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const t = adapterSpans().find((x) => x.type === "tool");
    expect(t!.name).toBe("openai-agents.tool.mcp.list_tools.my_mcp");
  });

  it("translates `custom` spans into a generic tool span (no semantic guess)", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("oa_9", "custom", "user_op");
      p.onSpanStart(s);
      p.onSpanEnd(s);
      return null;
    });
    const t = adapterSpans().find((x) => x.type === "tool");
    expect(t!.name).toBe("openai-agents.tool.custom.user_op");
  });
});

describe("MorseTraceProcessor — enrichFromRunResult (MHQ-787)", () => {
  // The real SDK's Responses-API path (the default) produces `'response'`
  // spans with a `response_id` but NO `model`/`usage` on the span itself —
  // that data only exists on `Runner.run()`'s resolved result. Model/usage
  // must arrive via `enrichFromRunResult`, not `onSpanEnd`.
  it("a `response` span with no model/usage of its own gets enriched from the run result", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("resp_1", "response", undefined, { response_id: "resp_abc" });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      // The span object is still mutable at this point — the outer trace
      // hasn't closed/exported yet — so a late patch still lands.
      p.enrichFromRunResult(
        [{ responseId: "resp_abc", usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 } }],
        "gpt-4o-mini",
      );
      return null;
    });
    const llm = adapterSpans().find((x) => x.type === "llm");
    expect(llm!.model).toBe("gpt-4o-mini");
    expect(llm!.input_tokens).toBe(15);
    expect(llm!.output_tokens).toBe(3);
    expect(llm!.total_tokens).toBe(18);
    expect(typeof llm!.cost_usd).toBe("number");
    expect(llm!.cost_usd as number).toBeGreaterThan(0);
  });

  it("enrichFromRunResult does not override a model the span already has", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("resp_2", "response", undefined, {
        response_id: "resp_def",
        model: "gpt-4o",
      });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      p.enrichFromRunResult(
        [{ responseId: "resp_def", usage: { inputTokens: 1, outputTokens: 1 } }],
        "gpt-4o-mini",
      );
      return null;
    });
    const llm = adapterSpans().find((x) => x.type === "llm");
    expect(llm!.model).toBe("gpt-4o");
  });

  it("enrichFromRunResult ignores entries with no matching response_id", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s = span("resp_3", "response", undefined, { response_id: "resp_ghi" });
      p.onSpanStart(s);
      p.onSpanEnd(s);
      expect(() =>
        p.enrichFromRunResult(
          [{ responseId: "resp_unrelated", usage: { inputTokens: 1 } }],
          "gpt-4o-mini",
        ),
      ).not.toThrow();
      return null;
    });
    const llm = adapterSpans().find((x) => x.type === "llm");
    expect(llm!.model).toBe("unknown");
  });
});

describe("MorseTraceProcessor — lifecycle + error handling", () => {
  it("onSpanEnd with no preceding onSpanStart is a silent no-op", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      // Skip start; only fire end.
      p.onSpanEnd(span("oa_orphan", "agent", "ghost"));
      return null;
    });
    expect(adapterSpans()).toHaveLength(0);
  });

  it("onSpanStart with no spanId is skipped without throwing", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const s: OpenAISpanLike = { spanData: { type: "agent", name: "no-id" } };
      expect(() => p.onSpanStart(s)).not.toThrow();
      expect(() => p.onSpanEnd(s)).not.toThrow();
      return null;
    });
  });

  it("processor outside any active trace returns null handles (no spans emitted, no throw)", () => {
    const p = new MorseTraceProcessor();
    expect(() => {
      const s = span("oa_no_trace", "agent", "x");
      p.onSpanStart(s);
      p.onSpanEnd(s);
    }).not.toThrow();
  });

  it("shutdown closes any still-open spans as failed", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      p.onSpanStart(span("oa_open", "function", "stuck"));
      await p.shutdown();
      return null;
    });
    const spans = adapterSpans();
    const stuck = spans.find((s) => s.name === "openai-agents.tool.stuck");
    expect(stuck).toBeDefined();
    expect(stuck!.status).toBe("failed");
  });

  it("onTraceStart / onTraceEnd are no-ops (handled by wrapRunner)", () => {
    const p = new MorseTraceProcessor();
    expect(() => p.onTraceStart({ traceId: "x", name: "y" })).not.toThrow();
    expect(() => p.onTraceEnd({ traceId: "x", name: "y" })).not.toThrow();
  });
});

describe("MorseTraceProcessor — multi-span sequences (realistic)", () => {
  it("nested agent → response → function → handoff produces one span per OpenAI span", async () => {
    const p = new MorseTraceProcessor();
    await runAsync({ agentName: "t" }, async () => {
      const a = span("a", "agent", "triage");
      const r = span("r", "response", undefined, {
        model: "gpt-4o-mini",
        usage: { input_tokens: 10, output_tokens: 4 },
      });
      const f = span("f", "function", "lookup", { input: {}, output: "ok" });
      const h = span("h", "handoff", undefined, { from_agent: "triage", to_agent: "expert" });
      p.onSpanStart(a);
      p.onSpanStart(r);
      p.onSpanEnd(r);
      p.onSpanStart(f);
      p.onSpanEnd(f);
      p.onSpanStart(h);
      p.onSpanEnd(h);
      p.onSpanEnd(a);
      return null;
    });
    const spans = adapterSpans();
    // 1 agent + 1 llm + 1 tool + 1 subagent-shape agent = 4
    expect(spans).toHaveLength(4);
    const types = spans.map((s) => s.type).sort();
    expect(types).toEqual(["agent", "agent", "llm", "tool"]);
  });
});

// AID-09: this suite pins the pre-0.7 (0.6.0) naming (chains as `agent` spans). The default
// shape is covered in tests/agent-identity-*.test.ts.
beforeAll(() => {
  process.env.MORSE_AGENT_IDENTITY = "legacy";
});
afterAll(() => {
  delete process.env.MORSE_AGENT_IDENTITY;
});
