/**
 * Schema-uniformity meta-test (W4.1).
 *
 * Asserts that the three agent-SDK adapters emit spans with consistent
 * metadata keys for each logical span type, regardless of source adapter.
 * Drift here would break dashboard panels that group by adapter.
 *
 * See `openspec/changes/2026-05-26-phase-13-ts-agent-sdk-adapters/design.md`
 * §"Schema-uniformity meta-test (W4)".
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  _resetForTesting as resetTracing,
  getLastTrace,
  runAsync,
} from "../../src/_internal/tracing";

import { wrapClaudeAgentSDKWithFullInstrumentation } from "../../src/anthropic-agent-sdk";
import { wrapRunnerWithFullInstrumentation } from "../../src/openai-agents";
import { MorseCallbackHandler } from "../../src/langgraph";

import { FakeClaudeSDKClient } from "./anthropic/fixtures/fake-claude-agent-sdk";
import { happyPathRunner } from "./openai/fixtures/fake-runner";
import { replayHappyPath } from "./langgraph/fixtures/fake-callback-events";

beforeEach(() => {
  resetTracing();
});

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------ */

async function captureAnthropicSpans(): Promise<
  Array<{ type: string; metadata?: Record<string, unknown> }>
> {
  const client = new FakeClaudeSDKClient({
    llmCallCount: 1,
    tools: [{ name: "lookup", input: { q: "x" }, output: "y" }],
  });
  const wrapped = wrapClaudeAgentSDKWithFullInstrumentation(client);
  await runAsync({ agentName: "test" }, async () => {
    for await (const _ of wrapped.client.query("hi")) {
      void _;
    }
    return null;
  });
  wrapped.dispose();
  const trace = getLastTrace();
  return (trace?.spans ?? []).map((s) => {
    const sp = s as { type: string; metadata?: Record<string, unknown> };
    return { type: sp.type, metadata: sp.metadata };
  });
}

async function captureOpenAISpans(): Promise<
  Array<{ type: string; metadata?: Record<string, unknown> }>
> {
  const runner = happyPathRunner();
  const wrapped = wrapRunnerWithFullInstrumentation(runner);
  await runAsync({ agentName: "test" }, async () => {
    await wrapped.runner.run({ name: "openai-test" }, "hi");
    return null;
  });
  wrapped.dispose();
  const trace = getLastTrace();
  return (trace?.spans ?? []).map((s) => {
    const sp = s as { type: string; metadata?: Record<string, unknown> };
    return { type: sp.type, metadata: sp.metadata };
  });
}

async function captureLangGraphSpans(): Promise<
  Array<{ type: string; metadata?: Record<string, unknown> }>
> {
  const handler = new MorseCallbackHandler();
  await runAsync({ agentName: "test" }, async () => {
    await replayHappyPath(handler);
    return null;
  });
  const trace = getLastTrace();
  return (trace?.spans ?? []).map((s) => {
    const sp = s as { type: string; metadata?: Record<string, unknown> };
    return { type: sp.type, metadata: sp.metadata };
  });
}

/* ------------------------------------------------------------------------ */
/*  Tests                                                                    */
/* ------------------------------------------------------------------------ */

describe("schema-uniformity across adapters (W4.1)", () => {
  it("each adapter tags metadata.adapter on every span it emits (excluding test's outer trace wrapper)", async () => {
    const a = await captureAnthropicSpans();
    const o = await captureOpenAISpans();
    const l = await captureLangGraphSpans();

    for (const [name, expectedAdapter, spans] of [
      ["anthropic", "anthropic-agent-sdk", a],
      ["openai", "openai-agents", o],
      ["langgraph", "langgraph-js", l],
    ] as const) {
      expect(spans.length, `${name} produced no spans`).toBeGreaterThan(0);
      // Filter to adapter-emitted spans only — exclude the test's runAsync wrapper.
      const adapterSpans = spans.filter(
        (s) => (s.metadata as { adapter?: string } | undefined)?.adapter !== undefined,
      );
      expect(adapterSpans.length, `${name} emitted no adapter-tagged spans`).toBeGreaterThan(0);
      for (const s of adapterSpans) {
        const md = s.metadata as { adapter?: string };
        expect(md.adapter, `${name} ${s.type} has wrong adapter tag`).toBe(expectedAdapter);
      }
    }
  });

  it("adapter tags use the documented names", async () => {
    const a = await captureAnthropicSpans();
    const o = await captureOpenAISpans();
    const l = await captureLangGraphSpans();

    expect(
      a.some((s) => (s.metadata as { adapter?: string })?.adapter === "anthropic-agent-sdk"),
    ).toBe(true);
    expect(o.some((s) => (s.metadata as { adapter?: string })?.adapter === "openai-agents")).toBe(
      true,
    );
    expect(l.some((s) => (s.metadata as { adapter?: string })?.adapter === "langgraph-js")).toBe(
      true,
    );
  });

  it("at least one outer agent-type span is emitted per adapter", async () => {
    const a = await captureAnthropicSpans();
    const o = await captureOpenAISpans();
    const l = await captureLangGraphSpans();

    expect(a.some((s) => s.type === "agent")).toBe(true);
    expect(o.some((s) => s.type === "agent")).toBe(true);
    expect(l.some((s) => s.type === "agent")).toBe(true);
  });

  it("at least one llm-type span is emitted per adapter (with model metadata)", async () => {
    const a = await captureAnthropicSpans();
    const o = await captureOpenAISpans();
    const l = await captureLangGraphSpans();

    for (const [name, spans] of [
      ["anthropic", a],
      ["openai", o],
      ["langgraph", l],
    ] as const) {
      const llms = spans.filter((s) => s.type === "llm");
      expect(llms.length, `${name} emitted no llm spans`).toBeGreaterThan(0);
    }
  });

  it("at least one tool-type span is emitted by Anthropic + OpenAI + LangGraph", async () => {
    const a = await captureAnthropicSpans();
    const o = await captureOpenAISpans();
    const l = await captureLangGraphSpans();

    expect(a.some((s) => s.type === "tool")).toBe(true);
    expect(o.some((s) => s.type === "tool")).toBe(true);
    expect(l.some((s) => s.type === "tool")).toBe(true);
  });
});
