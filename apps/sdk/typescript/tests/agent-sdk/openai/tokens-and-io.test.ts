/**
 * MHQ-1155 / MHQ-1156 — `/openai-agents` trace-processor wire payload.
 *
 * MHQ-1155: `@openai/agents` >= 0.3 emits `task` (whole run) and `turn`
 * (one agent turn) spans that carry an aggregated `usage`. The processor
 * copied `usage` onto whatever span it was translating, so a run with ONE
 * llm call reported its tokens three times (63 vs 21). Tokens belong on
 * `llm` spans only.
 *
 * MHQ-1156: llm spans had no `input_data` / `output_data` at all.
 *
 * Span shapes mirror `@openai/agents-core`'s `tracing/spans.d.ts` (0.18):
 * `response` spans carry `_input` / `_response`, `generation` spans carry
 * `input` / `output` / `usage`, `task` / `turn` carry `usage`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  MorseTraceProcessor,
  type OpenAISpanLike,
} from "../../../src/openai-agents/trace-processor";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

interface WireSpan {
  type: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  input_data?: unknown;
  output_data?: unknown;
  [k: string]: unknown;
}

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cached_input_tokens",
] as const;

function tokenSum(spans: WireSpan[]): number {
  return spans.reduce(
    (acc, s) => acc + TOKEN_FIELDS.reduce((a, f) => a + (typeof s[f] === "number" ? s[f] : 0), 0),
    0,
  );
}

async function drive(spans: OpenAISpanLike[]): Promise<WireSpan[]> {
  const proc = new MorseTraceProcessor();
  await runAsync({ agentName: "t" }, async () => {
    // Open in order, close in reverse — the SDK's own nesting.
    for (const s of spans) proc.onSpanStart(s);
    for (const s of [...spans].reverse()) proc.onSpanEnd(s);
    return null;
  });
  const trace = getLastTrace() as { spans: WireSpan[] } | null;
  expect(trace).not.toBeNull();
  return trace!.spans;
}

beforeEach(() => {
  _resetForTesting();
});

const runUsage = {
  input_tokens: 14,
  output_tokens: 7,
  total_tokens: 21,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  requests: 1,
};

describe("MHQ-1155: tokens only on llm spans", () => {
  it("one llm call + a tool + an agent: all-span token sum equals llm-span token sum", async () => {
    const spans = await drive([
      { spanId: "task", spanData: { type: "task", name: "run", usage: runUsage } },
      { spanId: "agent", spanData: { type: "agent", name: "bot" } },
      {
        spanId: "turn",
        spanData: { type: "turn", turn: 1, agent_name: "bot", usage: { ...runUsage } },
      },
      {
        spanId: "gen",
        spanData: {
          type: "generation",
          model: "gpt-4o-mini",
          usage: { input_tokens: 14, output_tokens: 7 },
        },
      },
      {
        spanId: "fn",
        spanData: { type: "function", name: "get_time", input: "{}", output: "12:00" },
      },
    ]);

    const llm = spans.filter((s) => s.type === "llm");
    const nonLlm = spans.filter((s) => s.type !== "llm");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.total_tokens).toBe(21);
    expect(nonLlm.some((s) => s.type === "tool")).toBe(true);
    expect(nonLlm.some((s) => s.type === "agent")).toBe(true);

    expect(tokenSum(spans)).toBe(tokenSum(llm));
    for (const s of nonLlm) {
      for (const f of TOKEN_FIELDS) expect(s[f], `${s.type}.${f}`).toBeUndefined();
    }
  });
});

describe("MHQ-1156: llm input/output capture", () => {
  it("response span (Responses API): captures _input and _response output", async () => {
    const spans = await drive([
      {
        spanId: "resp",
        spanData: {
          type: "response",
          response_id: "resp_1",
          _input: [{ role: "user", content: "what time is it?" }],
          _response: {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "It is noon." }],
              },
              { type: "function_call", name: "get_time", arguments: "{}" },
            ],
          },
        },
      },
    ]);
    const llm = spans.find((s) => s.type === "llm")!;
    expect(llm.input_data).toEqual({ messages: [{ role: "user", content: "what time is it?" }] });
    expect(llm.output_data).toEqual({ content: "It is noon.\n[tool_call:get_time] {}" });
  });

  it("response span with a bare string _input is captured as one user message", async () => {
    const spans = await drive([
      { spanId: "r", spanData: { type: "response", _input: "hello", _response: { output: [] } } },
    ]);
    const llm = spans.find((s) => s.type === "llm")!;
    expect(llm.input_data).toEqual({ messages: [{ role: "user", content: "hello" }] });
  });

  it("generation span (Chat Completions): captures input messages and output choices", async () => {
    const spans = await drive([
      {
        spanId: "g",
        spanData: {
          type: "generation",
          model: "gpt-4o-mini",
          input: [{ role: "user", content: "ping" }],
          output: [{ choices: [{ message: { role: "assistant", content: "pong" } }] }],
        },
      },
    ]);
    const llm = spans.find((s) => s.type === "llm")!;
    expect(llm.input_data).toEqual({ messages: [{ role: "user", content: "ping" }] });
    expect(llm.output_data).toEqual({ content: "pong" });
  });

  it("captured input/output go through the redaction path", async () => {
    const spans = await drive([
      {
        spanId: "r",
        spanData: {
          type: "response",
          _input: [{ role: "user", content: "my ssn is 123-45-6789" }],
          _response: {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "noted 123-45-6789" }],
              },
            ],
          },
        },
      },
    ]);
    const llm = spans.find((s) => s.type === "llm")!;
    const wire = JSON.stringify([llm.input_data, llm.output_data]);
    expect(wire).not.toContain("123-45-6789");
    expect(wire).toContain("[REDACTED:ssn]");
  });
});
