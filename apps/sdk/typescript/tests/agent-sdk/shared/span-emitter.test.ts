/**
 * Tests for `_agent-sdk-common/span-emitter.ts`.
 *
 * Each helper is exercised:
 *
 *   - inside an active trace (set up via `runAsync` from `_internal/tracing`)
 *     to confirm it produces exactly one span with the correct wire `type`,
 *     name, metadata, and (where applicable) top-level `SpanData` fields;
 *   - outside an active trace to confirm it returns `null` and does not throw;
 *   - with intentionally pathological inputs to confirm errors are absorbed.
 *
 * Spans are inspected via `getLastTrace()` after the surrounding `runAsync`
 * finalises — this avoids reaching into internal state and exercises the
 * same wire-shaping code path the real transport sees.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  emitAgentSpan,
  emitHookSpan,
  emitLlmSpan,
  emitSubagentSpan,
  emitToolSpan,
} from "../../../src/_agent-sdk-common/span-emitter";
import type { ContextSegment } from "../../../src/_internal/spans";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------ */

interface WireSpan {
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  context_segments?: ContextSegment[];
  [k: string]: unknown;
}

/**
 * Drives a trace via `runAsync`, invokes `inside(...)` to emit child spans,
 * waits one tick for the trace to flush, and returns all non-root spans
 * captured in the last trace.
 */
async function collectChildSpans(inside: () => void): Promise<WireSpan[]> {
  await runAsync({ agentName: "test-agent" }, async () => {
    inside();
  });
  const last = getLastTrace();
  if (last === null) return [];
  const spans = (last.spans as WireSpan[]).filter((s) => s.name !== "test-agent");
  return spans;
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  emitAgentSpan                                                            */
/* ------------------------------------------------------------------------ */

describe("emitAgentSpan", () => {
  it("emits exactly one wire type=agent span with adapter + agent_name metadata", async () => {
    const spans = await collectChildSpans(() => {
      const h = emitAgentSpan({
        adapter: "anthropic-agent-sdk",
        agentName: "qualifier",
      });
      h?.end();
    });
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.type).toBe("agent");
    expect(span.name).toBe("anthropic-agent-sdk.agent");
    expect(span.metadata?.adapter).toBe("anthropic-agent-sdk");
    expect(span.metadata?.agent_name).toBe("qualifier");
  });

  it("hydrates `model` onto both SpanData and metadata when supplied", async () => {
    const spans = await collectChildSpans(() => {
      const h = emitAgentSpan({
        adapter: "openai-agents",
        agentName: "support-bot",
        model: "gpt-4o",
      });
      h?.end();
    });
    expect(spans[0]!.model).toBe("gpt-4o");
    expect(spans[0]!.metadata?.model).toBe("gpt-4o");
  });

  it("returns null and does not throw when no active trace exists", () => {
    expect(() => {
      const h = emitAgentSpan({ adapter: "langgraph-js", agentName: "x" });
      expect(h).toBeNull();
    }).not.toThrow();
  });

  it("absorbs internal errors (empty agentName) — returns undefined, never throws", async () => {
    const spans = await collectChildSpans(() => {
      // Force the validator to throw; absorbErrors must swallow it.
      const result = emitAgentSpan({
        adapter: "anthropic-agent-sdk",
        agentName: "",
      });
      expect(result).toBeUndefined();
    });
    // No child span should have been opened.
    expect(spans).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  emitLlmSpan                                                              */
/* ------------------------------------------------------------------------ */

describe("emitLlmSpan", () => {
  it("emits a wire type=llm span and hydrates tokens + model + segments at top level", async () => {
    const segments: ContextSegment[] = [
      {
        position: 0,
        source: "system_prompt",
        content_hash: "h0",
      },
      {
        position: 1,
        source: "current_input",
        content_hash: "h1",
      },
    ];
    const spans = await collectChildSpans(() => {
      const h = emitLlmSpan({
        adapter: "anthropic-agent-sdk",
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        contextSegments: segments,
      });
      h?.end();
    });
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("llm");
    expect(s.name).toBe("anthropic-agent-sdk.llm");
    expect(s.model).toBe("claude-opus-4-7");
    expect(s.input_tokens).toBe(100);
    expect(s.output_tokens).toBe(50);
    expect(s.total_tokens).toBe(150);
    expect(s.context_segments).toEqual(segments);
    expect(s.metadata?.adapter).toBe("anthropic-agent-sdk");
    expect(s.metadata?.provider).toBe("anthropic");
    expect(s.metadata?.model).toBe("claude-opus-4-7");
  });

  it("derives total_tokens from input + output when totalTokens is omitted", async () => {
    const spans = await collectChildSpans(() => {
      const h = emitLlmSpan({
        adapter: "openai-agents",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 20,
      });
      h?.end();
    });
    expect(spans[0]!.total_tokens).toBe(30);
  });

  it("returns null with no active trace", () => {
    const h = emitLlmSpan({ adapter: "langgraph-js", model: "gpt-4o-mini" });
    expect(h).toBeNull();
  });

  it("absorbs missing model (returns undefined, no span opened)", async () => {
    const spans = await collectChildSpans(() => {
      const r = emitLlmSpan({
        adapter: "anthropic-agent-sdk",
        model: "",
      });
      expect(r).toBeUndefined();
    });
    expect(spans).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  emitToolSpan                                                             */
/* ------------------------------------------------------------------------ */

describe("emitToolSpan", () => {
  it("emits a wire type=tool span carrying tool name + summaries + success in metadata.tool", async () => {
    const spans = await collectChildSpans(() => {
      const h = emitToolSpan({
        adapter: "openai-agents",
        toolName: "search_web",
        inputSummary: { q: "hello" },
        outputSummary: { hits: 3 },
        durationMs: 42,
        success: true,
      });
      h?.end();
    });
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("tool");
    expect(s.name).toBe("openai-agents.tool.search_web");
    const tool = s.metadata?.tool as Record<string, unknown>;
    expect(tool.name).toBe("search_web");
    expect(tool.input_summary).toEqual({ q: "hello" });
    expect(tool.output_summary).toEqual({ hits: 3 });
    expect(tool.duration_ms).toBe(42);
    expect(tool.success).toBe(true);
    expect(s.metadata?.adapter).toBe("openai-agents");
  });

  it("returns null with no active trace", () => {
    expect(emitToolSpan({ adapter: "langgraph-js", toolName: "noop" })).toBeNull();
  });

  it("absorbs an empty toolName without throwing", async () => {
    const spans = await collectChildSpans(() => {
      const r = emitToolSpan({ adapter: "anthropic-agent-sdk", toolName: "" });
      expect(r).toBeUndefined();
    });
    expect(spans).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  emitSubagentSpan                                                         */
/* ------------------------------------------------------------------------ */

describe("emitSubagentSpan", () => {
  it("emits wire type=agent with spawn_kind=subagent + parent/sub names + task_description", async () => {
    const spans = await collectChildSpans(() => {
      const h = emitSubagentSpan({
        adapter: "anthropic-agent-sdk",
        parentAgentName: "orchestrator",
        subagentName: "researcher",
        taskDescription: "Look up the latest pricing",
      });
      h?.end();
    });
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("agent");
    expect(s.name).toBe("anthropic-agent-sdk.subagent.researcher");
    expect(s.metadata?.adapter).toBe("anthropic-agent-sdk");
    expect(s.metadata?.spawn_kind).toBe("subagent");
    expect(s.metadata?.parent_agent_name).toBe("orchestrator");
    expect(s.metadata?.subagent_name).toBe("researcher");
    expect(s.metadata?.task_description).toBe("Look up the latest pricing");
  });

  it("returns null with no active trace", () => {
    expect(
      emitSubagentSpan({
        adapter: "openai-agents",
        parentAgentName: "a",
        subagentName: "b",
      }),
    ).toBeNull();
  });

  it("absorbs missing parentAgentName without throwing", async () => {
    const spans = await collectChildSpans(() => {
      const r = emitSubagentSpan({
        adapter: "anthropic-agent-sdk",
        parentAgentName: "",
        subagentName: "x",
      });
      expect(r).toBeUndefined();
    });
    expect(spans).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  emitHookSpan                                                             */
/* ------------------------------------------------------------------------ */

describe("emitHookSpan", () => {
  it("emits wire type=tool with tool_kind=hook + hook.name + hook.kind", async () => {
    const spans = await collectChildSpans(() => {
      const h = emitHookSpan({
        adapter: "anthropic-agent-sdk",
        hookName: "redact-secrets",
        hookKind: "pre_tool",
        durationMs: 7,
      });
      h?.end();
    });
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("tool");
    expect(s.name).toBe("anthropic-agent-sdk.hook.pre_tool.redact-secrets");
    expect(s.metadata?.adapter).toBe("anthropic-agent-sdk");
    expect(s.metadata?.tool_kind).toBe("hook");
    const hook = s.metadata?.hook as Record<string, unknown>;
    expect(hook.name).toBe("redact-secrets");
    expect(hook.kind).toBe("pre_tool");
    expect(hook.duration_ms).toBe(7);
  });

  it("supports all three hook kinds", async () => {
    const spans = await collectChildSpans(() => {
      emitHookSpan({
        adapter: "anthropic-agent-sdk",
        hookName: "a",
        hookKind: "pre_tool",
      })?.end();
      emitHookSpan({
        adapter: "anthropic-agent-sdk",
        hookName: "b",
        hookKind: "post_tool",
      })?.end();
      emitHookSpan({
        adapter: "anthropic-agent-sdk",
        hookName: "c",
        hookKind: "on_error",
      })?.end();
    });
    expect(spans).toHaveLength(3);
    const kinds = spans.map((s) => (s.metadata?.hook as Record<string, unknown>).kind);
    expect(kinds).toEqual(["pre_tool", "post_tool", "on_error"]);
  });

  it("returns null with no active trace", () => {
    expect(
      emitHookSpan({
        adapter: "anthropic-agent-sdk",
        hookName: "x",
        hookKind: "pre_tool",
      }),
    ).toBeNull();
  });

  it("absorbs an invalid hookKind without throwing", async () => {
    const spans = await collectChildSpans(() => {
      const r = emitHookSpan({
        adapter: "anthropic-agent-sdk",
        hookName: "weird",
        // @ts-expect-error — intentionally invalid for the absorb-errors check
        hookKind: "garbage",
      });
      expect(r).toBeUndefined();
    });
    expect(spans).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  Cross-cutting: attributes pass-through                                   */
/* ------------------------------------------------------------------------ */

describe("attributes pass-through", () => {
  it("merges caller-supplied attributes into metadata across helpers", async () => {
    const spans = await collectChildSpans(() => {
      emitAgentSpan({
        adapter: "langgraph-js",
        agentName: "g",
        attributes: { tenant_id: "t-1" },
      })?.end();
      emitLlmSpan({
        adapter: "langgraph-js",
        model: "gpt-4o",
        attributes: { tenant_id: "t-1" },
      })?.end();
      emitToolSpan({
        adapter: "langgraph-js",
        toolName: "t",
        attributes: { tenant_id: "t-1" },
      })?.end();
    });
    expect(spans).toHaveLength(3);
    for (const s of spans) {
      expect(s.metadata?.tenant_id).toBe("t-1");
      expect(s.metadata?.adapter).toBe("langgraph-js");
    }
  });
});
