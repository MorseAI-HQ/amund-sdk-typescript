/**
 * Tests for `openai-agents/llm-and-tool.ts` — Phase 13 W2-O.2.
 *
 * Exercises the event-listener installer against the `FakeRunner` test
 * fixture, asserting that `llm_call_start`/`llm_call_end` and
 * `tool_call_start`/`tool_call_end` events produce well-formed `llm` and
 * `tool` spans on the active trace.
 *
 * Spans are inspected post-hoc via `getLastTrace()` after the surrounding
 * `runAsync` finalises.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { installLlmAndToolInstrumentation } from "../../../src/openai-agents/llm-and-tool";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";
import type { RunnerEventLike, RunnerLike } from "../../../src/openai-agents/types";
import { FakeRunner, happyPathRunner } from "./fixtures/fake-runner";

interface WireSpan {
  type: string;
  name: string;
  status?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Drive a fake runner inside a trace and return non-root spans. */
async function runWithInstrumentation(
  runner: FakeRunner,
  options?: Parameters<typeof installLlmAndToolInstrumentation>[1],
): Promise<WireSpan[]> {
  await runAsync({ agentName: "test-trace" }, async () => {
    const off = installLlmAndToolInstrumentation(runner, options);
    try {
      await runner.run({ name: "fixture" }, "input", {});
    } finally {
      off();
    }
  });
  const last = getLastTrace();
  if (last === null) return [];
  return (last.spans as WireSpan[]).filter((s) => s.name !== "test-trace");
}

beforeEach(() => {
  _resetForTesting();
});

describe("installLlmAndToolInstrumentation", () => {
  it("happy path emits one llm + one tool span", async () => {
    const spans = await runWithInstrumentation(happyPathRunner());
    expect(spans).toHaveLength(2);
    const llm = spans.find((s) => s.type === "llm")!;
    const tool = spans.find((s) => s.type === "tool")!;
    expect(llm).toBeDefined();
    expect(tool).toBeDefined();
  });

  it("llm span has model, provider, and usage tokens", async () => {
    const spans = await runWithInstrumentation(happyPathRunner());
    const llm = spans.find((s) => s.type === "llm")!;
    expect(llm.model).toBe("gpt-4o");
    expect(llm.input_tokens).toBe(40);
    expect(llm.output_tokens).toBe(20);
    expect(llm.total_tokens).toBe(60);
    expect(llm.metadata?.provider).toBe("openai");
    expect(llm.metadata?.adapter).toBe("openai-agents");
  });

  it("tool span has name, input summary, output summary, and success=true", async () => {
    const spans = await runWithInstrumentation(happyPathRunner());
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.name).toBe("openai-agents.tool.get_weather");
    const toolMeta = tool.metadata?.tool as Record<string, unknown>;
    expect(toolMeta.name).toBe("get_weather");
    expect(typeof toolMeta.input_summary).toBe("string");
    expect(toolMeta.input_summary as string).toContain("SF");
    expect(typeof toolMeta.output_summary).toBe("string");
    expect(toolMeta.output_summary as string).toContain("65");
    expect(toolMeta.success).toBe(true);
    expect(tool.status).toBe("completed");
  });

  it("tool with success=false closes the span as failed", async () => {
    const failingRunner = new FakeRunner({
      events: [
        { type: "tool_call_start", tool: { name: "broken", input: { x: 1 } } },
        {
          type: "tool_call_end",
          tool: { name: "broken", output: { err: "boom" }, success: false },
        },
      ],
    });
    const spans = await runWithInstrumentation(failingRunner);
    const tool = spans.find((s) => s.type === "tool")!;
    expect(tool.status).toBe("failed");
    const toolMeta = tool.metadata?.tool as Record<string, unknown>;
    expect(toolMeta.success).toBe(false);
  });

  it("multiple llm calls in sequence produce FIFO-matched spans", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "llm_call_start", llm: { model: "gpt-4o", provider: "openai" } },
        {
          type: "llm_call_end",
          llm: { model: "gpt-4o", usage: { input_tokens: 1, output_tokens: 2 } },
        },
        { type: "llm_call_start", llm: { model: "gpt-4o-mini", provider: "openai" } },
        {
          type: "llm_call_end",
          llm: { model: "gpt-4o-mini", usage: { input_tokens: 3, output_tokens: 4 } },
        },
      ],
    });
    const spans = await runWithInstrumentation(runner);
    const llms = spans.filter((s) => s.type === "llm");
    expect(llms).toHaveLength(2);
    expect(llms[0]!.model).toBe("gpt-4o");
    expect(llms[0]!.input_tokens).toBe(1);
    expect(llms[1]!.model).toBe("gpt-4o-mini");
    expect(llms[1]!.input_tokens).toBe(3);
  });

  it("mixed sequence (llm, tool, llm, tool) produces 4 spans with correct types", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "llm_call_start", llm: { model: "gpt-4o" } },
        { type: "llm_call_end", llm: { model: "gpt-4o", usage: { input_tokens: 1 } } },
        { type: "tool_call_start", tool: { name: "tool_a", input: {} } },
        { type: "tool_call_end", tool: { name: "tool_a", output: {}, success: true } },
        { type: "llm_call_start", llm: { model: "gpt-4o" } },
        { type: "llm_call_end", llm: { model: "gpt-4o", usage: { input_tokens: 2 } } },
        { type: "tool_call_start", tool: { name: "tool_b", input: {} } },
        { type: "tool_call_end", tool: { name: "tool_b", output: {}, success: true } },
      ],
    });
    const spans = await runWithInstrumentation(runner);
    expect(spans).toHaveLength(4);
    const types = spans.map((s) => s.type);
    expect(types.filter((t) => t === "llm")).toHaveLength(2);
    expect(types.filter((t) => t === "tool")).toHaveLength(2);
  });

  it("returns no-op unsubscriber when runner.on is missing", async () => {
    const fakeRunner = { run: async () => ({ finalOutput: "ok" }) } as unknown as RunnerLike;
    const off = installLlmAndToolInstrumentation(fakeRunner);
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("returned unsubscribe stops future events from producing spans", async () => {
    const runner = happyPathRunner();
    const spans = await new Promise<WireSpan[]>((resolve) => {
      void runAsync({ agentName: "trace" }, async () => {
        const off = installLlmAndToolInstrumentation(runner);
        off(); // immediately unsubscribe
        await runner.run({ name: "fixture" }, "input", {});
        const last = getLastTrace();
        resolve(last === null ? [] : (last.spans as WireSpan[]).filter((s) => s.name !== "trace"));
      }).then(() => {
        const last = getLastTrace();
        resolve(last === null ? [] : (last.spans as WireSpan[]).filter((s) => s.name !== "trace"));
      });
    });
    // After unsubscribe, no llm/tool spans should be captured.
    const interesting = spans.filter((s) => s.type === "llm" || s.type === "tool");
    expect(interesting).toHaveLength(0);
  });

  it("tolerates orphan _end without a matching _start", async () => {
    const runner = new FakeRunner({
      events: [
        // No start, but an end shows up. Should not throw.
        {
          type: "llm_call_end",
          llm: { model: "gpt-4o", usage: { input_tokens: 5 } },
        },
        {
          type: "tool_call_end",
          tool: { name: "ghost", output: {}, success: true },
        },
      ],
    });
    const spans = await runWithInstrumentation(runner);
    // No spans should be emitted from orphan _end events.
    expect(spans.filter((s) => s.type === "llm" || s.type === "tool")).toHaveLength(0);
  });

  it("falls back to 'unknown' when llm model or tool name is missing", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "llm_call_start", llm: {} },
        { type: "llm_call_end", llm: {} },
        { type: "tool_call_start", tool: { input: { x: 1 } } as RunnerEventLike["tool"] },
        {
          type: "tool_call_end",
          tool: { output: { y: 2 }, success: true } as RunnerEventLike["tool"],
        },
      ],
    });
    const spans = await runWithInstrumentation(runner);
    const llm = spans.find((s) => s.type === "llm")!;
    const tool = spans.find((s) => s.type === "tool")!;
    expect(llm.model).toBe("unknown");
    expect((tool.metadata?.tool as Record<string, unknown>).name).toBe("unknown");
  });

  it("uses event-provided total_tokens verbatim when present", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "llm_call_start", llm: { model: "gpt-4o" } },
        {
          type: "llm_call_end",
          llm: {
            model: "gpt-4o",
            // Intentionally inconsistent — total should win.
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 999 },
          },
        },
      ],
    });
    const spans = await runWithInstrumentation(runner);
    const llm = spans.find((s) => s.type === "llm")!;
    expect(llm.total_tokens).toBe(999);
  });

  it("propagates custom toolInputMaxBytes to the redaction helper", async () => {
    const big = "x".repeat(10_000);
    const runner = new FakeRunner({
      events: [
        { type: "tool_call_start", tool: { name: "big_input", input: { payload: big } } },
        { type: "tool_call_end", tool: { name: "big_input", output: {}, success: true } },
      ],
    });
    const spans = await runWithInstrumentation(runner, { toolInputMaxBytes: 64 });
    const tool = spans.find((s) => s.type === "tool")!;
    const summary = (tool.metadata?.tool as Record<string, unknown>).input_summary as string;
    expect(summary.length).toBeLessThanOrEqual(80); // 64 + truncation marker
  });

  it("propagates custom toolOutputMaxBytes to the redaction helper", async () => {
    const big = "y".repeat(10_000);
    const runner = new FakeRunner({
      events: [
        { type: "tool_call_start", tool: { name: "big_output", input: {} } },
        {
          type: "tool_call_end",
          tool: { name: "big_output", output: { payload: big }, success: true },
        },
      ],
    });
    const spans = await runWithInstrumentation(runner, { toolOutputMaxBytes: 64 });
    const tool = spans.find((s) => s.type === "tool")!;
    const summary = (tool.metadata?.tool as Record<string, unknown>).output_summary as string;
    expect(summary.length).toBeLessThanOrEqual(80);
  });

  it("decomposes event.llm.messages/tools into context_segments (MHQ-750)", async () => {
    const runner = new FakeRunner({
      events: [
        {
          type: "llm_call_start",
          llm: {
            model: "gpt-4o",
            provider: "openai",
            messages: [
              { role: "system", content: "You are helpful" },
              { role: "user", content: "what's the weather?" },
            ],
            tools: [{ type: "function", function: { name: "get_weather" } }],
          },
        },
        { type: "llm_call_end", llm: { model: "gpt-4o", usage: { input_tokens: 10 } } },
      ],
    });
    const spans = await runWithInstrumentation(runner);
    const llm = spans.find((s) => s.type === "llm")!;
    const segs = llm.context_segments as
      | Array<{ source: string; content?: string; attrs?: Record<string, unknown> }>
      | undefined;
    expect(segs).toBeDefined();
    expect(segs!.some((s) => s.source === "system_prompt" && s.content === "You are helpful")).toBe(
      true,
    );
    expect(
      segs!.some((s) => s.source === "current_input" && s.content === "what's the weather?"),
    ).toBe(true);
    const toolSeg = segs!.find((s) => s.source === "tool_descriptions");
    expect(toolSeg?.attrs?.tool_names).toContain("get_weather");
  });

  it("omits context_segments when event.llm.messages is absent", async () => {
    const spans = await runWithInstrumentation(happyPathRunner());
    const llm = spans.find((s) => s.type === "llm")!;
    expect(llm.context_segments).toBeUndefined();
  });

  it("defaults tool success to true when not provided", async () => {
    const runner = new FakeRunner({
      events: [
        { type: "tool_call_start", tool: { name: "implicit", input: {} } },
        { type: "tool_call_end", tool: { name: "implicit", output: {} } },
      ],
    });
    const spans = await runWithInstrumentation(runner);
    const tool = spans.find((s) => s.type === "tool")!;
    expect((tool.metadata?.tool as Record<string, unknown>).success).toBe(true);
    expect(tool.status).toBe("completed");
  });
});
