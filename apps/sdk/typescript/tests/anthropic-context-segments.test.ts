/* eslint-disable @typescript-eslint/no-unused-vars -- mock signatures mirror the SDK API; params intentionally unused (pre-existing, surfaced by MHQ-541 rename staging) */
/**
 * Anthropic adapter — context_segments extraction tests.
 *
 * These tests exercise the deterministic `extractAnthropicSegments`
 * helper end-to-end: ordering, source tagging, cache_state heuristics,
 * truncation, and the `wrapAnthropic` integration that ships segments
 * on the emitted `llm` span.
 *
 * Mirrors the segment contract in
 * `openspec/changes/.../specs/observability/spec.md` (CTX-08).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import {
  extractAnthropicSegments,
  isAnthropicWrapped,
  MAX_SEGMENT_CONTENT_BYTES,
  wrapAnthropic,
  type AnthropicClientLike,
  type AnthropicMessageCreateParams,
  type AnthropicMessageResponse,
} from "../src/anthropic/index";
import { type BatchTransport, type BatchTransportOptions } from "../src/_internal/transport";
import type { ContextSegment, SpanData } from "../src/_internal/spans";

/* ------------------------------------------------------------------------ */
/*  Test scaffolding                                                         */
/* ------------------------------------------------------------------------ */

interface MockTransport {
  events: unknown[];
}

function installMockTransport(): MockTransport {
  const state: MockTransport = { events: [] };
  morse._setTransportFactoryForTesting(
    (_opts: BatchTransportOptions) =>
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

const baseResponse = (model = "claude-opus-4-7"): AnthropicMessageResponse => ({
  id: "msg_test",
  model,
  usage: { input_tokens: 12, output_tokens: 34 },
  content: [{ type: "text", text: "ok" }],
});

beforeEach(() => {
  morse._resetForTesting();
  process.env.MORSE_API_KEY = "av_x";
});

afterEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_API_KEY;
});

/* ------------------------------------------------------------------------ */
/*  extractAnthropicSegments — deterministic helper                          */
/* ------------------------------------------------------------------------ */

describe("extractAnthropicSegments — basic ordering", () => {
  it("system + 1 user message → [system_prompt, current_input]", () => {
    const segments = extractAnthropicSegments({
      model: "claude-opus-4-7",
      system: "you are a helpful agent",
      messages: [{ role: "user", content: "hi there" }],
    });

    expect(segments.map((s) => s.source)).toEqual(["system_prompt", "current_input"]);
    expect(segments[0]!.position).toBe(0);
    expect(segments[1]!.position).toBe(1);
    expect(segments[0]!.content).toBe("you are a helpful agent");
    expect(segments[1]!.content).toBe("hi there");
    // hashes are non-empty hex digests
    expect(segments[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(segments[1]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // tokens left for the server to compute
    expect(segments[0]!.tokens).toBeUndefined();
    expect(segments[1]!.tokens).toBeUndefined();
  });

  it("tools array present → 3 segments with tool_descriptions at position 0", () => {
    const segments = extractAnthropicSegments({
      model: "claude-opus-4-7",
      system: "system text",
      tools: [
        {
          name: "search",
          description: "Search the web",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      messages: [{ role: "user", content: "find me lunch" }],
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]!.source).toBe("tool_descriptions");
    expect(segments[0]!.position).toBe(0);
    expect(segments[1]!.source).toBe("system_prompt");
    expect(segments[2]!.source).toBe("current_input");
    // tool_descriptions content is canonical JSON of the tools array
    expect(segments[0]!.content).toContain('"name":"search"');
    expect(segments[0]!.content).toContain('"description":"Search the web"');
  });

  it("multi-turn conversation: only the last user message is current_input", () => {
    const segments = extractAnthropicSegments({
      model: "claude-opus-4-7",
      messages: [
        { role: "user", content: "turn 1 user" },
        { role: "assistant", content: "turn 1 assistant" },
        { role: "user", content: "turn 2 user" },
        { role: "assistant", content: "turn 2 assistant" },
        { role: "user", content: "turn 3 user" },
        { role: "assistant", content: "turn 3 assistant" },
        { role: "user", content: "final question" },
      ],
    });

    const sources = segments.map((s) => s.source);
    // 6 chat_history + 1 current_input
    expect(sources.filter((s) => s === "chat_history")).toHaveLength(6);
    expect(sources.filter((s) => s === "current_input")).toHaveLength(1);
    // current_input is the LAST segment
    expect(segments[segments.length - 1]!.source).toBe("current_input");
    expect(segments[segments.length - 1]!.content).toBe("final question");
    // positions are sequential and dense
    segments.forEach((s, i) => expect(s.position).toBe(i));
  });
});

describe("extractAnthropicSegments — tool_result blocks", () => {
  it("tool_result block in user content emits a tool_observation segment", () => {
    const segments = extractAnthropicSegments({
      model: "claude-opus-4-7",
      messages: [
        { role: "user", content: "what's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { location: "SF" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "72F sunny",
            },
            { type: "text", text: "and?" },
          ],
        },
      ],
    });

    const sources = segments.map((s) => s.source);
    // Order: chat_history(user "what's"), chat_history(assistant tool_use),
    // current_input(user "and?"), tool_observation(72F sunny)
    expect(sources).toContain("tool_observation");
    const obs = segments.find((s) => s.source === "tool_observation");
    expect(obs).toBeDefined();
    expect(obs!.content).toBe("72F sunny");
    expect((obs!.attrs as Record<string, unknown>).tool_use_id).toBe("toolu_1");
    // current_input was the trailing text in the same final-user message
    const current = segments.find((s) => s.source === "current_input");
    expect(current).toBeDefined();
    expect(current!.content).toBe("and?");
  });

  it("tool_result with is_error=true marks attrs.is_error", () => {
    const segments = extractAnthropicSegments({
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              content: "boom",
              is_error: true,
            },
          ],
        },
      ],
    });
    const obs = segments.find((s) => s.source === "tool_observation");
    expect(obs).toBeDefined();
    expect((obs!.attrs as Record<string, unknown>).is_error).toBe(true);
  });
});

describe("extractAnthropicSegments — cache_state", () => {
  it("system as TextBlockParam[] with cache_control=ephemeral → cache_write", () => {
    const segments = extractAnthropicSegments({
      model: "claude-opus-4-7",
      system: [
        { type: "text", text: "expensive system prompt" },
        {
          type: "text",
          text: "second cached block",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    const sys = segments.find((s) => s.source === "system_prompt");
    expect(sys).toBeDefined();
    expect(sys!.cache_state).toBe("cache_write");
    // text content is concatenation of both blocks
    expect(sys!.content).toContain("expensive system prompt");
    expect(sys!.content).toContain("second cached block");
  });

  it("response usage cache_read_input_tokens > 0 → system_prompt + tool_descriptions become cache_hit", () => {
    const params: AnthropicMessageCreateParams = {
      model: "claude-opus-4-7",
      system: "cached prefix",
      tools: [{ name: "search", description: "x", input_schema: {} }],
      messages: [{ role: "user", content: "hi" }],
    };
    const response: AnthropicMessageResponse = {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 500,
      },
      content: [{ type: "text", text: "ok" }],
    };
    const segments = extractAnthropicSegments(params, response);
    const tools = segments.find((s) => s.source === "tool_descriptions");
    const sys = segments.find((s) => s.source === "system_prompt");
    const user = segments.find((s) => s.source === "current_input");
    expect(tools!.cache_state).toBe("cache_hit");
    expect(sys!.cache_state).toBe("cache_hit");
    // user message segment is unaffected.
    expect(user!.cache_state).toBe("cold");
  });
});

describe("extractAnthropicSegments — truncation + hashing", () => {
  it("content over 4096 bytes is truncated and content_truncated=true", () => {
    const longText = "x".repeat(5000);
    const segments = extractAnthropicSegments({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: longText }],
    });
    const seg = segments[0]!;
    expect(seg.content_truncated).toBe(true);
    // Byte length must not exceed the cap.
    const byteLen = new TextEncoder().encode(seg.content!).length;
    expect(byteLen).toBeLessThanOrEqual(MAX_SEGMENT_CONTENT_BYTES);
    // The hash is computed over the FULL pre-truncation content, so it
    // depends only on the original text — make sure it's stable.
    const seg2 = extractAnthropicSegments({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: longText }],
    })[0]!;
    expect(seg2.content_hash).toBe(seg.content_hash);
  });

  it("hash is stable across object key orderings", () => {
    const a = extractAnthropicSegments({
      model: "claude-opus-4-7",
      tools: [{ name: "t", description: "d", input_schema: { a: 1, b: 2 } }],
      messages: [{ role: "user", content: "hi" }],
    });
    const b = extractAnthropicSegments({
      model: "claude-opus-4-7",
      tools: [{ description: "d", name: "t", input_schema: { b: 2, a: 1 } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(a[0]!.content_hash).toBe(b[0]!.content_hash);
  });
});

/* ------------------------------------------------------------------------ */
/*  wrapAnthropic — integration with the trace state                          */
/* ------------------------------------------------------------------------ */

// MHQ-482: `run()`/`span()`'s emission path now goes through the real OTel
// pipeline (`_internal/otel-provider.ts`), not the JSON `BatchTransport` —
// mirrors the Python SDK's MHQ-668 split. `_getLastTraceForTesting()` stays
// wired up regardless of which pipeline actually ships the trace (see
// `tracing.ts::sendTrace`), so it's the right introspection point here.
describe("wrapAnthropic — adds llm span with context_segments", () => {
  it("adds llm span carrying context_segments to the active trace state", async () => {
    morse.init({ apiKey: "av_x" });

    const client = makeFakeClient(() => baseResponse());
    const wrapped = wrapAnthropic(client);
    expect(isAnthropicWrapped(wrapped)).toBe(true);
    expect(isAnthropicWrapped(client)).toBe(false);

    await wrapped.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 256,
      system: "you are helpful",
      messages: [{ role: "user", content: "hello world" }],
    });
    // wait for the runAsync wrapper to flush the trace
    await new Promise((r) => setTimeout(r, 10));

    expect(client._create).toHaveBeenCalledTimes(1);
    const last = morse._getLastTraceForTesting() as { spans: Record<string, unknown>[] } | null;
    expect(last).not.toBeNull();
    const spans = last!.spans;
    const llm = spans.find((s) => s.type === "llm") as Record<string, unknown> | undefined;
    expect(llm).toBeDefined();
    expect(llm!.model).toBe("claude-opus-4-7");
    const segments = llm!.context_segments as ContextSegment[] | undefined;
    expect(segments).toBeDefined();
    expect(segments!.map((s) => s.source)).toEqual(["system_prompt", "current_input"]);
    // token counts surfaced from the response.
    expect(llm!.input_tokens).toBe(12);
    expect(llm!.output_tokens).toBe(34);
    expect(llm!.total_tokens).toBe(46);
  });

  it("propagates the underlying call's return value verbatim", async () => {
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() => ({
      id: "msg_xyz",
      model: "claude-opus-4-7",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [{ type: "text", text: "answer" }],
    }));
    const wrapped = wrapAnthropic(client);
    const result = await wrapped.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 64,
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.id).toBe("msg_xyz");
    expect(result.content?.[0]).toMatchObject({ type: "text", text: "answer" });
  });

  it("non-invasive: the underlying call's error propagates unchanged", async () => {
    installMockTransport();
    morse.init({ apiKey: "av_x" });
    const error = new Error("rate limited");
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(async () => {
          throw error;
        }),
      },
    } as unknown as AnthropicClientLike;
    const wrapped = wrapAnthropic(client);
    await expect(
      wrapped.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 64,
        messages: [{ role: "user", content: "q" }],
      }),
    ).rejects.toThrow("rate limited");
  });

  it("wrapping the same client twice is idempotent", () => {
    const client = makeFakeClient(() => baseResponse());
    const w1 = wrapAnthropic(client);
    const w2 = wrapAnthropic(w1);
    expect(w2).toBe(w1);
  });

  it("emits one llm span per call when run inside an existing trace", async () => {
    morse.init({ apiKey: "av_x" });
    const client = makeFakeClient(() => baseResponse());
    const wrapped = wrapAnthropic(client);

    await morse.runTraced({ agentName: "outer-agent" }, async () => {
      await wrapped.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 64,
        messages: [{ role: "user", content: "first" }],
      });
      await wrapped.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 64,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      });
    });

    // Same trace, two llm spans.
    const last = morse._getLastTraceForTesting() as { spans: SpanData[] } | null;
    expect(last).not.toBeNull();
    const spans = last!.spans;
    const llmSpans = spans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(2);
    expect(llmSpans.every((s) => Array.isArray(s.context_segments))).toBe(true);
  });
});
