/**
 * Tests for `_internal/pricing.ts` — pricing table lookup + cost calculation.
 *
 * Mirrors `apps/sdk/python/tests/test_pricing.py` case-for-case, plus an
 * adapter-wiring section confirming `cost_usd` actually lands on the
 * emitted `llm` span for the `anthropic` adapter (the auto-compute
 * precedence the Python adapters implement).
 */

import { describe, expect, it } from "vitest";
import { calculateCost, getModelPricing } from "../src/_internal/pricing";
import * as morse from "../src/index";
import { wrapAnthropic, type AnthropicClientLike } from "../src/anthropic/index";
import type { BatchTransport } from "../src/_internal/transport";

describe("getModelPricing", () => {
  it("matches an exact model id", () => {
    const pricing = getModelPricing("claude-sonnet-4-6");
    expect(pricing).toBeDefined();
    expect(pricing?.input_per_mtok).toBe(3.0);
    expect(pricing?.output_per_mtok).toBe(15.0);
  });

  it("matches via longest-prefix with a date suffix", () => {
    const pricing = getModelPricing("claude-sonnet-4-6-20260217");
    expect(pricing).toBeDefined();
    expect(pricing?.input_per_mtok).toBe(3.0);
  });

  it("matches an OpenAI model", () => {
    const pricing = getModelPricing("gpt-4.1");
    expect(pricing).toBeDefined();
    expect(pricing?.input_per_mtok).toBe(2.0);
    expect(pricing?.output_per_mtok).toBe(8.0);
  });

  it("returns undefined for an unknown model", () => {
    expect(getModelPricing("unknown-model-xyz")).toBeUndefined();
  });
});

describe("calculateCost", () => {
  it("computes basic input + output cost", () => {
    const cost = calculateCost({
      inputTokens: 1000,
      outputTokens: 500,
      model: "claude-sonnet-4-6",
    });
    expect(cost).toBeDefined();
    const expected = (1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0;
    expect(Math.abs((cost as number) - expected)).toBeLessThan(1e-10);
  });

  it("computes cost with cache read + cache write tokens", () => {
    const cost = calculateCost({
      inputTokens: 1000,
      outputTokens: 500,
      model: "claude-sonnet-4-6",
      cachedInputTokens: 300,
      cacheWriteTokens: 200,
    });
    expect(cost).toBeDefined();
    // 700 standard input + 300 cached + 200 cache write + 500 output
    const standard = (700 / 1_000_000) * 3.0;
    const cached = (300 / 1_000_000) * 0.3;
    const write = (200 / 1_000_000) * 3.75;
    const output = (500 / 1_000_000) * 15.0;
    const expected = standard + cached + write + output;
    expect(Math.abs((cost as number) - expected)).toBeLessThan(1e-10);
  });

  it("returns undefined for an unknown model", () => {
    const cost = calculateCost({
      inputTokens: 1000,
      outputTokens: 500,
      model: "nonexistent-model",
    });
    expect(cost).toBeUndefined();
  });

  it("returns 0 for zero tokens on a known model", () => {
    const cost = calculateCost({
      inputTokens: 0,
      outputTokens: 0,
      model: "claude-sonnet-4-6",
    });
    expect(cost).toBe(0);
  });
});

describe("provider normalization", () => {
  it("strips a LiteLLM openai/ prefix", () => {
    const p = getModelPricing("openai/gpt-4o");
    expect(p?.input_per_mtok).toBe(2.5);
  });

  it("strips a double OpenRouter prefix", () => {
    const p = getModelPricing("openrouter/openai/gpt-4o");
    expect(p?.input_per_mtok).toBe(2.5);
  });

  it("strips a Bedrock vendor prefix and version suffix", () => {
    const p = getModelPricing("bedrock/anthropic.claude-sonnet-4-5-v1:0");
    expect(p?.input_per_mtok).toBe(3.0);
  });

  it("strips a Bedrock cross-region prefix", () => {
    const p = getModelPricing("us.anthropic.claude-3-haiku-20240307-v1:0");
    expect(p?.input_per_mtok).toBe(0.25);
  });

  it("matches gpt-5 with the corrected price", () => {
    const p = getModelPricing("gpt-5");
    expect(p).toBeDefined();
    expect(p?.input_per_mtok).toBe(1.25);
    expect(p?.output_per_mtok).toBe(10.0);
  });

  it("matches newer providers (gemini, vertex_ai, mistral, cohere, deepseek)", () => {
    expect(getModelPricing("gemini-2.5-pro")?.input_per_mtok).toBe(1.25);
    expect(getModelPricing("vertex_ai/gemini-2.5-flash")?.output_per_mtok).toBe(2.5);
    expect(getModelPricing("mistral-large-latest")?.input_per_mtok).toBe(2.0);
    expect(getModelPricing("command-r-08-2024")?.input_per_mtok).toBe(0.15);
    expect(getModelPricing("deepseek-chat")?.output_per_mtok).toBe(0.28);
  });
});

/* ------------------------------------------------------------------------ */
/*  Adapter wiring — cost_usd auto-computed on the emitted span              */
/* ------------------------------------------------------------------------ */

function installMockTransport(): { events: unknown[] } {
  const state: { events: unknown[] } = { events: [] };
  morse._setTransportFactoryForTesting(
    () =>
      ({
        track(event: unknown): boolean {
          state.events.push(event);
          return true;
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      }) as unknown as BatchTransport,
  );
  return state;
}

describe("anthropic adapter — cost_usd auto-computed from pricing table", () => {
  it("sets cost_usd on the llm span when the model is in the pricing table", async () => {
    installMockTransport();
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret

    const create = async () => ({
      id: "msg_test",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: "text", text: "ok" }],
    });
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const wrapped = wrapAnthropic(client);

    await wrapped.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{ role: "user", content: "hello" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    // MHQ-482: run()/span() go through the real OTel pipeline now, not
    // `transport.track()` — read the closed trace back the same way
    // tests/anthropic-context-segments.test.ts does post-otel-provider.
    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llm = last?.spans.find((s) => s.type === "llm");
    expect(llm).toBeDefined();
    const expected = (1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0;
    expect(llm!.cost_usd as number).toBeCloseTo(expected, 10);

    morse._resetForTesting();
  });

  it("leaves cost_usd unset when the model is unknown to the pricing table", async () => {
    installMockTransport();
    morse.init({ apiKey: "av_x" }); // pragma: allowlist secret

    const create = async () => ({
      id: "msg_test",
      model: "totally-unknown-model-xyz",
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: "text", text: "ok" }],
    });
    const client = { messages: { create } } as unknown as AnthropicClientLike;
    const wrapped = wrapAnthropic(client);

    await wrapped.messages.create({
      model: "totally-unknown-model-xyz",
      max_tokens: 256,
      messages: [{ role: "user", content: "hello" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    const llm = last?.spans.find((s) => s.type === "llm");
    expect(llm).toBeDefined();
    expect(llm!.cost_usd).toBeUndefined();

    morse._resetForTesting();
  });
});
