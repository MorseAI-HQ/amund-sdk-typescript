/**
 * Anthropic adapter — summarize hook tests (MEM-11/12).
 *
 * When the customer wraps an Anthropic client with `wrapAnthropic(client,
 * { summarize: true })`, every `messages.create` call emits the existing
 * `llm` span (CTX-08) AND a sibling `memory` span with:
 *
 *   - type = "memory"
 *   - parent_span_id = the LLM span's span_id (server treats as producer_span_id)
 *   - metadata.memory_op_type = "consolidate"
 *   - metadata.summary_token_count = response.usage.output_tokens
 *   - metadata.summary_content_hash = SHA-256 of the first text block
 *
 * Mirrors the Python suite under tests/test_anthropic_summarize.py and the
 * spec scenarios in openspec/changes/memory-profiler/specs/sdk/spec.md.
 *
 * @spec MEM-12
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import {
  extractAnthropicSegments,
  wrapAnthropic,
  type AnthropicClientLike,
  type AnthropicMessageCreateParams,
  type AnthropicMessageResponse,
} from "../src/anthropic/index";
import { type BatchTransport } from "../src/_internal/transport";
import type { SpanData } from "../src/_internal/spans";

/* ------------------------------------------------------------------------ */
/*  Test scaffolding                                                         */
/* ------------------------------------------------------------------------ */

interface MockTransport {
  events: unknown[];
}

function installMockTransport(): MockTransport {
  const state: MockTransport = { events: [] };
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

function makeFakeClient(
  responseFactory: (params: AnthropicMessageCreateParams) => AnthropicMessageResponse,
): AnthropicClientLike & { _create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async (params: AnthropicMessageCreateParams) => responseFactory(params));
  return {
    messages: { create },
    _create: create,
  } as unknown as AnthropicClientLike & { _create: ReturnType<typeof vi.fn> };
}

const SUMMARY_TEXT = "this is a summary of the conversation";

const summaryResponse = (
  overrides: Partial<AnthropicMessageResponse> = {},
): AnthropicMessageResponse => ({
  id: "msg_summary",
  model: "claude-haiku-4-5",
  usage: { input_tokens: 1000, output_tokens: 42 },
  content: [{ type: "text", text: SUMMARY_TEXT }],
  ...overrides,
});

// MHQ-482: `wrapAnthropic`'s spans are emitted inside a `run()`/`span()`
// trace, whose emission path now goes through the real OTel pipeline
// (`_internal/otel-provider.ts`), not the JSON `BatchTransport` — mirrors
// the Python SDK's MHQ-668 split. The `transport` param is unused now
// (kept so call sites didn't all need reshaping) — `_getLastTraceForTesting()`
// is the introspection point that stays wired up regardless of which
// pipeline actually ships the trace (see `tracing.ts::sendTrace`).
function spansFromLastEvent(): SpanData[] {
  const last = morse._getLastTraceForTesting() as { spans: SpanData[] } | null;
  expect(last).not.toBeNull();
  return last!.spans;
}

/**
 * Compute the SDK's content_hash for an arbitrary text via the public
 * `extractAnthropicSegments` helper — both code paths share the same
 * internal `sha256Hex`, so this gives us the exact bytes the SDK will emit
 * without exporting an internal symbol. Crucially, the server matches the
 * summarize-hook's `summary_content_hash` against subsequent LLM spans'
 * `content_segments[].content_hash` — they MUST come from the same hash
 * function or the cross-span linkage breaks.
 */
function sdkContentHashOf(text: string): string {
  return extractAnthropicSegments({
    model: "x",
    messages: [{ role: "user", content: text }],
  })[0]!.content_hash;
}

beforeEach(() => {
  morse._resetForTesting();
  process.env.MORSE_API_KEY = "av_x";
});

afterEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_API_KEY;
});

/* ------------------------------------------------------------------------ */
/*  MEM-12 — explicit spec scenarios                                         */
/* ------------------------------------------------------------------------ */

describe("wrapAnthropic — summarize: true (MEM-12)", () => {
  it("emits a sibling memory span alongside the LLM span", async () => {
    // @spec: MEM-12
    installMockTransport();
    morse.init({ apiKey: "av_x" });

    const client = makeFakeClient(() => summaryResponse());
    const wrapped = wrapAnthropic(client, { summarize: true });

    await wrapped.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system: "Summarize this conversation in 200 words.",
      messages: [
        { role: "user", content: "Long transcript turn 1..." },
        { role: "assistant", content: "Long transcript turn 2..." },
        { role: "user", content: "Long transcript turn 3..." },
      ],
    });
    await new Promise((r) => setTimeout(r, 10));

    const spans = spansFromLastEvent();
    const llmSpans = spans.filter((s) => s.type === "llm");
    const memorySpans = spans.filter((s) => s.type === "memory");
    expect(llmSpans).toHaveLength(1);
    expect(memorySpans).toHaveLength(1);
    expect(memorySpans[0]!.name).toBe("anthropic.summarize");
    expect((memorySpans[0]!.metadata as Record<string, unknown>).memory_op_type).toBe(
      "consolidate",
    );
  });

  it("memory span's parent_span_id equals the LLM span's span_id", async () => {
    // @spec: MEM-12
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() => summaryResponse());
    const wrapped = wrapAnthropic(client, { summarize: true });

    await wrapped.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "old transcript" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const spans = spansFromLastEvent();
    const llm = spans.find((s) => s.type === "llm")!;
    const memory = spans.find((s) => s.type === "memory")!;
    expect(memory.parent_span_id).toBe(llm.span_id);
  });

  it("sets memory_op_type=consolidate + token count + content hash", async () => {
    // @spec: MEM-12
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() =>
      summaryResponse({ usage: { input_tokens: 5000, output_tokens: 200 } }),
    );
    const wrapped = wrapAnthropic(client, { summarize: true });

    await wrapped.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "old transcript" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const spans = spansFromLastEvent();
    const memory = spans.find((s) => s.type === "memory")!;
    const meta = memory.metadata as Record<string, unknown>;
    expect(meta.memory_op_type).toBe("consolidate");
    expect(meta.summary_token_count).toBe(200);
    expect(meta.summary_content_hash).toBe(sdkContentHashOf(SUMMARY_TEXT));
    // And the value is a well-formed 64-char hex digest.
    expect(meta.summary_content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("summarize=false (default) preserves CTX-08 behavior — no memory span", async () => {
    // @spec: MEM-12
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() => summaryResponse());
    // NOTE: no options, so summarize defaults to false.
    const wrapped = wrapAnthropic(client);

    await wrapped.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "anything" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const spans = spansFromLastEvent();
    const llmSpans = spans.filter((s) => s.type === "llm");
    const memorySpans = spans.filter((s) => s.type === "memory");
    expect(llmSpans).toHaveLength(1);
    expect(memorySpans).toHaveLength(0);
  });

  it("explicit summarize=false is identical to omitting the option", async () => {
    // @spec: MEM-12
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() => summaryResponse());
    const wrapped = wrapAnthropic(client, { summarize: false });

    await wrapped.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "anything" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const spans = spansFromLastEvent();
    expect(spans.filter((s) => s.type === "memory")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/*  Additional safety checks (non-MEM-12 but adjacent)                       */
/* ------------------------------------------------------------------------ */

describe("wrapAnthropic — summarize safety", () => {
  it("response with empty content emits the empty-string SHA-256 — no crash", async () => {
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() => ({
      id: "msg_empty",
      model: "claude-haiku-4-5",
      usage: { input_tokens: 10, output_tokens: 0 },
      content: [],
    }));
    const wrapped = wrapAnthropic(client, { summarize: true });

    await wrapped.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "x" }],
    });
    await new Promise((r) => setTimeout(r, 10));

    const spans = spansFromLastEvent();
    const memory = spans.find((s) => s.type === "memory")!;
    const meta = memory.metadata as Record<string, unknown>;
    expect(meta.summary_content_hash).toBe(sdkContentHashOf(""));
    expect(meta.summary_token_count).toBe(0);
  });

  it("inside an existing trace, the memory span lives in the same trace", async () => {
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() => summaryResponse());
    const wrapped = wrapAnthropic(client, { summarize: true });

    await morse.runTraced({ agentName: "outer-agent" }, async () => {
      await wrapped.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 256,
        messages: [{ role: "user", content: "old transcript" }],
      });
    });

    const spans = spansFromLastEvent();
    const llm = spans.find((s) => s.type === "llm")!;
    const memory = spans.find((s) => s.type === "memory")!;
    // Both LLM + memory carry the SAME trace_id as the outer agent span.
    expect(memory.trace_id).toBe(llm.trace_id);
    expect(memory.parent_span_id).toBe(llm.span_id);
  });
});
