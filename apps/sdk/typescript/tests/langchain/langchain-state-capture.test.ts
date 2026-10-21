/**
 * Tests for `src/langchain/callback-handler.ts`'s `coerceStateValue` — the
 * TS port of the Python adapter's `_ensure_dict` (AGE-260, Issue 3).
 *
 * Mirrors `apps/sdk/python/tests/test_langchain_state_capture.py`'s case
 * granularity, adapted for JS's type system: there is no Pydantic v1/v2 or
 * dataclass ecosystem in JS, so those cases are replaced by the JS
 * analogues this file's `coerceStateValue` actually implements — plain
 * object passthrough, a `toJSON()` duck-typed coercion path (JS's nearest
 * equivalent to Pydantic's `model_dump()`/`dict()`), and the same
 * never-drop-to-undefined / oversized-payload-truncation guarantees.
 */

import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";

import { MorseCallbackHandler, coerceStateValue } from "../../src/langchain/callback-handler";
import { _resetForTesting, getLastTrace, runSync } from "../../src/_internal/tracing";

const MAX_STATE_PAYLOAD_BYTES = 64 * 1024;

interface WireSpan {
  type?: string;
  name?: string;
  input_data?: unknown;
  output_data?: unknown;
  [k: string]: unknown;
}

function lastSpans(): WireSpan[] {
  const last = getLastTrace();
  return (last?.spans as WireSpan[] | undefined) ?? [];
}

let runIdCounter = 0;
function newRunId(): string {
  runIdCounter += 1;
  return `run-${runIdCounter}`;
}

beforeEach(() => {
  _resetForTesting();
  runIdCounter = 0;
});

/** Drive handleChainStart/End with the given inputs/outputs and return the span. */
function captureChainSpan(
  handler: MorseCallbackHandler,
  inputs: unknown,
  outputs: unknown,
): WireSpan {
  const runId = newRunId();
  runSync({ agentName: "test-agent" }, () => {
    handler.handleChainStart(
      { id: ["langgraph", "nodes", "TestNode"], name: "TestNode" },
      inputs as never,
      runId,
    );
    handler.handleChainEnd(outputs as never, runId);
  });
  const spans = lastSpans().filter((s) => s.type === "agent" && s.name === "TestNode");
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

/* ------------------------------------------------------------------------ */
/* 1. Plain object — pass-through (regression guard).                       */
/* ------------------------------------------------------------------------ */

describe("coerceStateValue — plain object passthrough", () => {
  it("captures plain-object input/output unchanged", () => {
    const handler = new MorseCallbackHandler({ agentName: "test" });
    const span = captureChainSpan(
      handler,
      { messages: [{ role: "user", content: "hi" }], step: 1 },
      { messages: [{ role: "assistant", content: "hello" }], step: 2 },
    );
    expect(span.input_data).toEqual({ messages: [{ role: "user", content: "hi" }], step: 1 });
    expect(span.output_data).toEqual({
      messages: [{ role: "assistant", content: "hello" }],
      step: 2,
    });
  });
});

/* ------------------------------------------------------------------------ */
/* 2. `toJSON()`-bearing object — coerced via duck-typed toJSON().           */
/* ------------------------------------------------------------------------ */

describe("coerceStateValue — toJSON() duck typing", () => {
  it("coerces an object exposing toJSON() returning a plain object", () => {
    class StateWithToJSON {
      constructor(
        private question: string,
        private turnCount: number,
      ) {}
      toJSON(): Record<string, unknown> {
        return { question: this.question, turn_count: this.turnCount };
      }
    }
    const handler = new MorseCallbackHandler({ agentName: "test" });
    const span = captureChainSpan(
      handler,
      new StateWithToJSON("what?", 3),
      new StateWithToJSON("what?", 4),
    );
    expect(span.input_data).toEqual({ question: "what?", turn_count: 3 });
    expect(span.output_data).toEqual({ question: "what?", turn_count: 4 });
  });

  it("falls back to {value: String(x)} when toJSON() throws", () => {
    class Broken {
      toJSON(): never {
        throw new Error("nope");
      }
      toString(): string {
        return "<broken>";
      }
    }
    const result = coerceStateValue(new Broken());
    expect(result).toEqual({ value: "<broken>" });
  });
});

/* ------------------------------------------------------------------------ */
/* 3. Plain scalars / arrays — wrapped in {value: String(...)}, never drop. */
/* ------------------------------------------------------------------------ */

describe("coerceStateValue — non-object values wrapped, never dropped", () => {
  it.each([
    ["a plain string state", "a plain string state"],
    [42, "42"],
    [["list", "of", "things"], JSON.stringify(["list", "of", "things"])],
  ])("wraps %j as {value: ...}, never undefined", (value, expected) => {
    const handler = new MorseCallbackHandler({ agentName: "test" });
    const span = captureChainSpan(handler, value, value);
    expect(span.input_data).not.toBeUndefined();
    expect(span.output_data).not.toBeUndefined();
    expect(span.input_data).toEqual({ value: expected });
    expect(span.output_data).toEqual({ value: expected });
  });
});

/* ------------------------------------------------------------------------ */
/* 4. Genuine null/undefined — stays absent (not all callbacks carry data). */
/* ------------------------------------------------------------------------ */

describe("coerceStateValue — genuine null/undefined stays absent", () => {
  it("does not set input_data/output_data when input is null", () => {
    const handler = new MorseCallbackHandler({ agentName: "test" });
    const runId = newRunId();
    runSync({ agentName: "test-agent" }, () => {
      handler.handleChainStart(
        { id: ["nodes", "EmptyNode"], name: "EmptyNode" },
        null as never,
        runId,
      );
      handler.handleChainEnd(null as never, runId);
    });
    const spans = lastSpans().filter((s) => s.name === "EmptyNode");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.input_data).toBeUndefined();
    expect(spans[0]!.output_data).toBeUndefined();
  });

  it("coerceStateValue(undefined) === undefined and coerceStateValue(null) === undefined", () => {
    expect(coerceStateValue(undefined)).toBeUndefined();
    expect(coerceStateValue(null)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */
/* 5. Oversized payload — truncated with marker, NOT dropped.               */
/* ------------------------------------------------------------------------ */

describe("coerceStateValue — oversized payload truncation", () => {
  it("truncates a payload exceeding MAX_STATE_PAYLOAD_BYTES with a marker, not None", () => {
    const handler = new MorseCallbackHandler({ agentName: "test" });
    const bigStr = "x".repeat(MAX_STATE_PAYLOAD_BYTES + 10_000);
    const big = { messages: [{ role: "user", content: bigStr }] };
    const span = captureChainSpan(handler, big, big);

    const input = span.input_data as Record<string, unknown>;
    expect(input).not.toBeUndefined();
    expect(input._truncated).toBe(true);
    expect(input._reason).toBe("payload_too_large");
    expect(typeof input.preview).toBe("string");
    expect((input.preview as string).length).toBeGreaterThan(0);
    expect(input._original_size_bytes as number).toBeGreaterThan(MAX_STATE_PAYLOAD_BYTES);
    expect(input._max_bytes).toBe(MAX_STATE_PAYLOAD_BYTES);

    const output = span.output_data as Record<string, unknown>;
    expect(output._truncated).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* 6. Nested arbitrary object inside a plain dict round-trips.              */
/* ------------------------------------------------------------------------ */

describe("coerceStateValue — nested object inside a dict round-trips", () => {
  it("preserves the top-level dict shape; nested class instances survive JSON.stringify", () => {
    class Sub {
      constructor(private x: number) {}
      toJSON(): Record<string, unknown> {
        return { x: this.x };
      }
    }
    const handler = new MorseCallbackHandler({ agentName: "test" });
    const span = captureChainSpan(
      handler,
      { sub: new Sub(1), msg: "hi" },
      { sub: new Sub(2), msg: "ok" },
    );
    expect(span.input_data).not.toBeUndefined();
    expect((span.input_data as Record<string, unknown>).msg).toBe("hi");
    expect(span.output_data).not.toBeUndefined();
    expect((span.output_data as Record<string, unknown>).msg).toBe("ok");
  });
});

/* ------------------------------------------------------------------------ */
/* 7. Direct unit tests on coerceStateValue (no callback plumbing).         */
/* ------------------------------------------------------------------------ */

describe("coerceStateValue — direct unit tests", () => {
  it("returns undefined for null/undefined", () => {
    expect(coerceStateValue(null)).toBeUndefined();
    expect(coerceStateValue(undefined)).toBeUndefined();
  });

  it("passes through a plain object unchanged", () => {
    expect(coerceStateValue({ a: 1 })).toEqual({ a: 1 });
  });

  it("wraps an unserializable-looking object via String() fallback", () => {
    class Weird {
      toString(): string {
        return "<weird>";
      }
    }
    const result = coerceStateValue(new Weird());
    expect(result).toEqual({ value: "<weird>" });
  });

  it("truncation marker is itself JSON-encodable (no recursion)", () => {
    const bigDict = { data: "y".repeat(MAX_STATE_PAYLOAD_BYTES + 100) };
    const result = coerceStateValue(bigDict);
    expect(result).not.toBeUndefined();
    const encoded = JSON.stringify(result);
    expect(encoded).toContain("_truncated");
  });
});

// AID-09: this suite pins the pre-0.8 naming (chains as `agent` spans). The default
// shape is covered in tests/agent-identity-*.test.ts.
beforeAll(() => {
  process.env.MORSE_AGENT_IDENTITY = "legacy";
});
afterAll(() => {
  delete process.env.MORSE_AGENT_IDENTITY;
});
