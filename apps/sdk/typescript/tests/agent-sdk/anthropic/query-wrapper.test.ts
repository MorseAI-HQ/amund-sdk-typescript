/**
 * Tests for `src/anthropic-agent-sdk/query-wrapper.ts` (MHQ-936).
 *
 * The fixture mirrors the REAL `@anthropic-ai/claude-agent-sdk` surface, which
 * the previous client-based adapter did not:
 *   - `query({ prompt, options })` — one object argument, not `(prompt, options)`
 *   - returns a `Query`: an AsyncGenerator PLUS control methods
 *     (`interrupt()`, `setPermissionMode()`)
 *
 * The control-method assertions matter most. A plain `async function*` wrapper
 * iterates perfectly and silently drops every control method — the caller only
 * finds out when `interrupt()` is `undefined` at runtime, with nothing pointing
 * at telemetry as the cause.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  isClaudeAgentQueryWrapped,
  wrapClaudeAgentQuery,
} from "../../../src/anthropic-agent-sdk/query-wrapper";
import type { ClaudeAgentQueryFn } from "../../../src/anthropic-agent-sdk/query-wrapper";
import type { SDKMessageLike } from "../../../src/anthropic-agent-sdk/types";
import { _resetForTesting, getLastTrace } from "../../../src/_internal/tracing";

interface WireSpan {
  type: string;
  name: string;
  status?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

const MESSAGES: SDKMessageLike[] = [
  { type: "system", subtype: "init" } as unknown as SDKMessageLike,
  {
    type: "assistant",
    message: {
      model: "claude-opus-4-5",
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  } as unknown as SDKMessageLike,
  { type: "result", subtype: "success" } as unknown as SDKMessageLike,
];

/** Records control-method calls so we can prove they reached the real Query. */
interface FakeQueryCalls {
  interrupted: number;
  permissionModes: string[];
  params: unknown[];
}

function makeFakeQuery(
  messages: SDKMessageLike[] = MESSAGES,
  throwAfter?: number,
): { query: ClaudeAgentQueryFn; calls: FakeQueryCalls } {
  const calls: FakeQueryCalls = { interrupted: 0, permissionModes: [], params: [] };

  const query = ((params: unknown) => {
    calls.params.push(params);

    async function* gen(): AsyncGenerator<SDKMessageLike, void, unknown> {
      let i = 0;
      for (const m of messages) {
        if (throwAfter !== undefined && i === throwAfter) throw new Error("upstream boom");
        yield m;
        i++;
      }
    }

    const inner = gen();
    // A Query: generator protocol + control methods, like the real package.
    return {
      [Symbol.asyncIterator]: () => inner,
      next: inner.next.bind(inner),
      return: inner.return.bind(inner),
      throw: inner.throw.bind(inner),
      interrupt: async () => {
        calls.interrupted++;
        return undefined;
      },
      setPermissionMode: async (mode: string) => {
        calls.permissionModes.push(mode);
      },
      someFutureControlMethod: () => "forwarded",
      sessionId: "session-abc",
    } as never;
  }) as ClaudeAgentQueryFn;

  return { query, calls };
}

async function drain(q: AsyncIterable<SDKMessageLike>): Promise<{
  events: SDKMessageLike[];
  spans: WireSpan[];
}> {
  const events: SDKMessageLike[] = [];
  for await (const e of q) events.push(e);
  await new Promise((r) => setTimeout(r, 0));
  return { events, spans: (getLastTrace()?.spans as WireSpan[] | undefined) ?? [] };
}

beforeEach(() => {
  _resetForTesting();
});

describe("wrapClaudeAgentQuery — the real query() shape", () => {
  it("passes the single object argument through untouched", async () => {
    const { query, calls } = makeFakeQuery();
    const traced = wrapClaudeAgentQuery(query);

    await drain(traced({ prompt: "hi", options: { model: "claude-opus-4-5" } }));

    expect(calls.params).toEqual([{ prompt: "hi", options: { model: "claude-opus-4-5" } }]);
  });

  it("yields every message unchanged", async () => {
    const { query } = makeFakeQuery();
    const { events } = await drain(wrapClaudeAgentQuery(query)({ prompt: "hi" }));

    expect(events).toEqual(MESSAGES);
  });

  it("emits one adapter agent span carrying the model from params.options", async () => {
    const { query } = makeFakeQuery();
    const { spans } = await drain(
      wrapClaudeAgentQuery(query)({ prompt: "hi", options: { model: "claude-opus-4-5" } }),
    );

    // Two `agent` spans are expected outside an existing trace: the implicit
    // root opened by runAsync, plus the adapter's own. Assert on the adapter's.
    const emitted = spans.filter(
      (s) => s.type === "agent" && s.metadata?.adapter === "anthropic-agent-sdk",
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.model).toBe("claude-opus-4-5");
  });

  it("is idempotent — wrapping twice does not double-count spans", async () => {
    const { query } = makeFakeQuery();
    const once = wrapClaudeAgentQuery(query);
    const twice = wrapClaudeAgentQuery(once);

    expect(twice).toBe(once);
    expect(isClaudeAgentQueryWrapped(twice)).toBe(true);

    const { spans } = await drain(twice({ prompt: "hi" }));
    expect(
      spans.filter((s) => s.type === "agent" && s.metadata?.adapter === "anthropic-agent-sdk"),
    ).toHaveLength(1);
  });
});

describe("wrapClaudeAgentQuery — Query control methods survive", () => {
  it("forwards interrupt() to the real Query", async () => {
    const { query, calls } = makeFakeQuery();
    const q = wrapClaudeAgentQuery(query)({ prompt: "hi" }) as unknown as {
      interrupt: () => Promise<unknown>;
    };

    expect(typeof q.interrupt).toBe("function");
    await q.interrupt();
    expect(calls.interrupted).toBe(1);
  });

  it("forwards setPermissionMode() to the real Query", async () => {
    const { query, calls } = makeFakeQuery();
    const q = wrapClaudeAgentQuery(query)({ prompt: "hi" }) as unknown as {
      setPermissionMode: (m: string) => Promise<void>;
    };

    await q.setPermissionMode("plan");
    expect(calls.permissionModes).toEqual(["plan"]);
  });

  it("forwards control methods the SDK has not invented yet, and plain properties", () => {
    const { query } = makeFakeQuery();
    const q = wrapClaudeAgentQuery(query)({ prompt: "hi" }) as unknown as {
      someFutureControlMethod: () => string;
      sessionId: string;
    };

    // The Proxy forwards by default rather than allow-listing known methods —
    // otherwise every new upstream control method would silently disappear.
    expect(q.someFutureControlMethod()).toBe("forwarded");
    expect(q.sessionId).toBe("session-abc");
  });
});

describe("wrapClaudeAgentQuery — failure paths", () => {
  it("rethrows an upstream error unchanged and closes the span as failed", async () => {
    const { query } = makeFakeQuery(MESSAGES, 1);

    await expect(drain(wrapClaudeAgentQuery(query)({ prompt: "hi" }))).rejects.toThrow(
      "upstream boom",
    );

    await new Promise((r) => setTimeout(r, 0));
    const spans = (getLastTrace()?.spans as WireSpan[] | undefined) ?? [];
    const agentSpan = spans.find((s) => s.type === "agent");
    expect(agentSpan?.status).toBe("failed");
  });

  it("opens no span for a query that is created but never iterated", async () => {
    const { query } = makeFakeQuery();
    wrapClaudeAgentQuery(query)({ prompt: "hi" });

    await new Promise((r) => setTimeout(r, 0));
    const spans = (getLastTrace()?.spans as WireSpan[] | undefined) ?? [];
    expect(spans.filter((s) => s.type === "agent")).toHaveLength(0);
  });

  it("returns a non-function input unchanged instead of throwing", () => {
    expect(wrapClaudeAgentQuery(undefined as unknown as ClaudeAgentQueryFn)).toBeUndefined();
  });
});

/**
 * The real CLI emits ONE `assistant` event PER CONTENT BLOCK of a single API
 * response, each repeating the same `message.id` and the same `usage`. Seen
 * on dev with 0.6.0-rc.2 + claude-haiku-4-5: two llm spans of 25218 input
 * tokens each for one call (trace total 2x). Python emits one.
 */
const HAIKU_USAGE = {
  input_tokens: 3,
  cache_creation_input_tokens: 25215,
  cache_read_input_tokens: 0,
  output_tokens: 6,
};
function assistantChunk(id: string, block: Record<string, unknown>): SDKMessageLike {
  return {
    type: "assistant",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [block],
      stop_reason: null,
      usage: { ...HAIKU_USAGE },
    },
  } as unknown as SDKMessageLike;
}

describe("wrapClaudeAgentQuery — llm spans from the real per-block message stream", () => {
  it("emits ONE llm span for one API call split across several assistant events", async () => {
    const { query } = makeFakeQuery([
      { type: "system", subtype: "init", session_id: "sess-1" } as unknown as SDKMessageLike,
      assistantChunk("msg_01", { type: "thinking", thinking: "the user wants a greeting" }),
      assistantChunk("msg_01", { type: "text", text: "Hello there!" }),
      { type: "result", subtype: "success", session_id: "sess-1" } as unknown as SDKMessageLike,
    ]);
    const { spans } = await drain(
      wrapClaudeAgentQuery(query)({ prompt: "Say hello", options: { maxTurns: 1 } }),
    );
    const llm = spans.filter((s) => s.type === "llm");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.input_tokens).toBe(25218);
    expect(llm[0]!.output_tokens).toBe(6);
  });

  it("still emits one llm span per turn in a genuine multi-turn run", async () => {
    const { query } = makeFakeQuery([
      assistantChunk("msg_01", { type: "text", text: "Let me check." }),
      assistantChunk("msg_01", {
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "date" },
      }),
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Thu" }],
        },
      } as unknown as SDKMessageLike,
      assistantChunk("msg_02", { type: "text", text: "It is Thursday." }),
      { type: "result", subtype: "success" } as unknown as SDKMessageLike,
    ]);
    const { spans } = await drain(wrapClaudeAgentQuery(query)({ prompt: "What day is it?" }));
    expect(spans.filter((s) => s.type === "llm")).toHaveLength(2);
  });

  it("captures the prompt as input_data and the assistant text as output_data", async () => {
    const { query } = makeFakeQuery([
      assistantChunk("msg_01", { type: "thinking", thinking: "internal" }),
      assistantChunk("msg_01", { type: "text", text: "Hello there!" }),
      { type: "result", subtype: "success" } as unknown as SDKMessageLike,
    ]);
    const { spans } = await drain(wrapClaudeAgentQuery(query)({ prompt: "Say hello" }));
    const llm = spans.filter((s) => s.type === "llm");
    expect(llm).toHaveLength(1);
    expect(llm[0]!.input_data).toEqual({ messages: [{ role: "user", content: "Say hello" }] });
    expect(llm[0]!.output_data).toEqual({ content: "Hello there!" });
  });
});
