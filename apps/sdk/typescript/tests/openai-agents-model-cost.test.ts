/**
 * MHQ-926: openai-agents llm spans must carry a model, and therefore a cost.
 *
 * `new Agent({ name, instructions })` — i.e. relying on the SDK's default
 * model, which is the common case — leaves `agent.model` as the EMPTY STRING.
 * `enrichFromRunResult` treated that as "no fallback", so the span stayed
 * `model: "unknown"`, `calculateCost` returned undefined, and every
 * openai-agents llm span landed with a null `cost_usd`.
 *
 * The model was available the whole time under `raw.providerData.model` — the
 * dated id the provider actually billed. Verified against @openai/agents on
 * 2026-08-04: `raw.model` is undefined, `raw.providerData.model` is
 * "gpt-5.4-mini-2026-03-17", and the pricing table normalises dated ids.
 */

import { describe, expect, it } from "vitest";

import { MorseTraceProcessor } from "../src/openai-agents/trace-processor";

interface FakeSpan {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
}

function processorWithOpenSpan(span: FakeSpan, responseId: string): MorseTraceProcessor {
  const proc = new MorseTraceProcessor();
  // Reach into the response-span registry the way onSpanEnd would have left it.
  (
    proc as unknown as { closedResponseSpans: Map<string, { span: FakeSpan }> }
  ).closedResponseSpans.set(responseId, { span });
  return proc;
}

describe("MHQ-926 — openai-agents model + cost enrichment", () => {
  it("takes the model from providerData when the Agent has no explicit model", () => {
    const span: FakeSpan = { model: "unknown" };
    const proc = processorWithOpenSpan(span, "resp_1");

    proc.enrichFromRunResult(
      [
        {
          responseId: "resp_1",
          usage: { inputTokens: 19, outputTokens: 9 },
          providerData: { model: "gpt-5.4-mini-2026-03-17" },
        },
      ],
      "", // agent.model is the empty string — this is the bug's trigger
    );

    expect(span.model).toBe("gpt-5.4-mini-2026-03-17");
    // Pre-fix this was undefined, because model stayed "unknown".
    expect(span.cost_usd).toBeGreaterThan(0);
    expect(span.total_tokens).toBe(28);
  });

  it("prefers the served model over the configured fallback", () => {
    const span: FakeSpan = { model: "unknown" };
    const proc = processorWithOpenSpan(span, "resp_2");

    proc.enrichFromRunResult(
      [
        {
          responseId: "resp_2",
          usage: { inputTokens: 10, outputTokens: 5 },
          providerData: { model: "gpt-4o-mini-2024-07-18" },
        },
      ],
      "gpt-4o", // configured, but not what was actually billed
    );

    expect(span.model).toBe("gpt-4o-mini-2024-07-18");
  });

  it("still uses the fallback when providerData carries no model", () => {
    const span: FakeSpan = { model: "unknown" };
    const proc = processorWithOpenSpan(span, "resp_3");

    proc.enrichFromRunResult(
      [{ responseId: "resp_3", usage: { inputTokens: 10, outputTokens: 5 }, providerData: {} }],
      "gpt-4o-mini",
    );

    expect(span.model).toBe("gpt-4o-mini");
    expect(span.cost_usd).toBeGreaterThan(0);
  });

  it("does not overwrite a model the span already resolved", () => {
    const span: FakeSpan = { model: "gpt-4o" };
    const proc = processorWithOpenSpan(span, "resp_4");

    proc.enrichFromRunResult(
      [
        {
          responseId: "resp_4",
          usage: { inputTokens: 10, outputTokens: 5 },
          providerData: { model: "gpt-4o-mini-2024-07-18" },
        },
      ],
      undefined,
    );

    expect(span.model).toBe("gpt-4o");
  });
});
