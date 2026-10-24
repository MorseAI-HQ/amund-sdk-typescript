/**
 * Tests for `src/anthropic-agent-sdk/client-wrapper.ts` (W2-A.1).
 *
 * Asserts that the outer-span wrapper:
 *   - opens exactly one `agent` span around each `query()` invocation,
 *   - tags it with `metadata.adapter="anthropic-agent-sdk"` + `agent_name`,
 *   - honors the `defaultAgentName` / `defaultModel` overrides,
 *   - forwards every `SDKMessageLike` event unchanged,
 *   - is idempotent (re-wrapping returns the first wrapper),
 *   - closes the span on iterator drain (success) or rethrows mid-iteration
 *     errors with the span ending in `failed`,
 *   - handles the two-mode `instrumentClaudeAgentSDK` installer correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  instrumentClaudeAgentSDK,
  isClaudeAgentSDKWrapped,
  wrapClaudeAgentSDK,
} from "../../../src/anthropic-agent-sdk/client-wrapper";
import type {
  ClaudeSDKClientLike,
  ClaudeSDKQueryOptions,
  SDKMessageLike,
} from "../../../src/anthropic-agent-sdk/types";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

import { FakeClaudeSDKClient, happyPathClient } from "./fixtures/fake-claude-agent-sdk";

interface WireSpan {
  type: string;
  name: string;
  status?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Drain the wrapper's `query()` iterator and return all spans on the most
 * recent trace (root + child agent span).
 */
async function drainAndGetSpans(
  iter: AsyncIterable<SDKMessageLike> | Promise<AsyncIterable<SDKMessageLike>>,
): Promise<{ events: SDKMessageLike[]; spans: WireSpan[] }> {
  const resolved = iter instanceof Promise ? await iter : iter;
  const events: SDKMessageLike[] = [];
  for await (const e of resolved) events.push(e);
  // Allow microtasks to flush — _runAsync resolves once the inner generator
  // signals completion; the trace flush happens synchronously after.
  await new Promise((r) => setTimeout(r, 0));
  const last = getLastTrace();
  const spans = (last?.spans as WireSpan[] | undefined) ?? [];
  return { events, spans };
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  wrap surface                                                             */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDK — surface", () => {
  it("returns an object exposing `query`, `on`, and `off` from the original client", () => {
    const client = new FakeClaudeSDKClient();
    const wrapped = wrapClaudeAgentSDK(client);
    expect(typeof wrapped.query).toBe("function");
    expect(typeof wrapped.on).toBe("function");
    expect(typeof wrapped.off).toBe("function");
  });

  it("`isClaudeAgentSDKWrapped` is false for raw clients, true for wrapped clients", () => {
    const raw = new FakeClaudeSDKClient();
    expect(isClaudeAgentSDKWrapped(raw)).toBe(false);
    const wrapped = wrapClaudeAgentSDK(raw);
    expect(isClaudeAgentSDKWrapped(wrapped)).toBe(true);
  });

  it("wrapping is idempotent — wrapping a wrapped client returns it as-is", () => {
    const raw = new FakeClaudeSDKClient();
    const once = wrapClaudeAgentSDK(raw);
    const twice = wrapClaudeAgentSDK(once);
    expect(twice).toBe(once);
  });

  it("returns the input unchanged for non-client values", () => {
    // @ts-expect-error — intentional bad input
    expect(wrapClaudeAgentSDK(null)).toBeNull();
    // @ts-expect-error — intentional bad input
    expect(wrapClaudeAgentSDK(undefined)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ */
/*  outer-span emission                                                      */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDK — outer agent span", () => {
  // These pin the legacy shape (MORSE_AGENT_IDENTITY=legacy): an extra
  // `anthropic-agent-sdk.agent` span under the trace root. The default (agent
  // identity v2, MHQ-1416) records the root as the only agent span; see
  // "identity v2" below.
  let savedIdentity: string | undefined;
  beforeEach(() => {
    savedIdentity = process.env.MORSE_AGENT_IDENTITY;
    process.env.MORSE_AGENT_IDENTITY = "legacy";
  });
  afterEach(() => {
    if (savedIdentity === undefined) delete process.env.MORSE_AGENT_IDENTITY;
    else process.env.MORSE_AGENT_IDENTITY = savedIdentity;
  });

  it("opens exactly one `type=agent` span tagged with the adapter + default agent_name", async () => {
    const wrapped = wrapClaudeAgentSDK(happyPathClient());
    const { spans } = await drainAndGetSpans(wrapped.query("hi"));
    // 2 spans expected: implicit root (from _runAsync) + emitted agent span.
    const agentSpans = spans.filter((s) => s.type === "agent");
    expect(agentSpans.length).toBeGreaterThanOrEqual(1);
    const emitted = agentSpans.find((s) => s.name === "anthropic-agent-sdk.agent");
    expect(emitted).toBeDefined();
    expect(emitted!.metadata?.adapter).toBe("anthropic-agent-sdk");
    expect(emitted!.metadata?.agent_name).toBe("claude-agent-sdk");
  });

  it("`defaultAgentName` overrides the emitted span's agent_name metadata", async () => {
    const wrapped = wrapClaudeAgentSDK(happyPathClient(), {
      defaultAgentName: "my-custom-agent",
    });
    const { spans } = await drainAndGetSpans(wrapped.query("hi"));
    const emitted = spans.find((s) => s.name === "anthropic-agent-sdk.agent");
    expect(emitted).toBeDefined();
    expect(emitted!.metadata?.agent_name).toBe("my-custom-agent");
  });

  it("`defaultModel` is hydrated onto the agent span when no per-call model is set", async () => {
    const wrapped = wrapClaudeAgentSDK(happyPathClient(), {
      defaultModel: "claude-opus-4-7",
    });
    const { spans } = await drainAndGetSpans(wrapped.query("hi"));
    const emitted = spans.find((s) => s.name === "anthropic-agent-sdk.agent");
    expect(emitted!.model).toBe("claude-opus-4-7");
    expect(emitted!.metadata?.model).toBe("claude-opus-4-7");
  });

  it("per-call `options.model` takes precedence over `defaultModel`", async () => {
    const wrapped = wrapClaudeAgentSDK(happyPathClient(), {
      defaultModel: "claude-opus-4-7",
    });
    const opts: ClaudeSDKQueryOptions = { model: "claude-sonnet-4-5" };
    const { spans } = await drainAndGetSpans(wrapped.query("hi", opts));
    const emitted = spans.find((s) => s.name === "anthropic-agent-sdk.agent");
    expect(emitted!.model).toBe("claude-sonnet-4-5");
  });
});

/* ------------------------------------------------------------------------ */
/*  event forwarding                                                         */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDK — event forwarding", () => {
  it("yields every event the underlying client produces, unchanged and in order", async () => {
    const raw = happyPathClient();
    // Drain the raw client first to capture the expected event stream.
    const expected: SDKMessageLike[] = [];
    const rawIter = raw.query("hi");
    const rawResolved = rawIter instanceof Promise ? await rawIter : rawIter;
    for await (const e of rawResolved) expected.push(e);

    const wrapped = wrapClaudeAgentSDK(happyPathClient());
    const observed: SDKMessageLike[] = [];
    const wrappedIter = wrapped.query("hi");
    const wrappedResolved = wrappedIter instanceof Promise ? await wrappedIter : wrappedIter;
    for await (const e of wrappedResolved) observed.push(e);

    expect(observed).toEqual(expected);
  });

  it("closes the agent span with `completed` status on successful drain", async () => {
    const wrapped = wrapClaudeAgentSDK(happyPathClient());
    const { spans } = await drainAndGetSpans(wrapped.query("hi"));
    // MHQ-1416: the trace root is the agent span.
    const agents = spans.filter((s) => s.type === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("completed");
  });
});

/* ------------------------------------------------------------------------ */
/*  error handling                                                           */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDK — errors", () => {
  // These pin the legacy shape (MORSE_AGENT_IDENTITY=legacy): an extra
  // `anthropic-agent-sdk.agent` span under the trace root. The default (agent
  // identity v2, MHQ-1416) records the root as the only agent span; see
  // "identity v2" below.
  let savedIdentity: string | undefined;
  beforeEach(() => {
    savedIdentity = process.env.MORSE_AGENT_IDENTITY;
    process.env.MORSE_AGENT_IDENTITY = "legacy";
  });
  afterEach(() => {
    if (savedIdentity === undefined) delete process.env.MORSE_AGENT_IDENTITY;
    else process.env.MORSE_AGENT_IDENTITY = savedIdentity;
  });

  it("rethrows mid-iteration errors and closes the agent span with `failed` status", async () => {
    class ExplodingClient implements ClaudeSDKClientLike {
      async *query(
        _prompt: string | unknown,
        _options?: ClaudeSDKQueryOptions,
      ): AsyncIterable<SDKMessageLike> {
        void _prompt;
        void _options;
        yield { type: "message_start", message: { id: "msg_0" } };
        throw new Error("simulated upstream failure");
      }
    }
    const wrapped = wrapClaudeAgentSDK(new ExplodingClient());
    let thrown: unknown;
    const events: SDKMessageLike[] = [];
    try {
      const it = wrapped.query("hi");
      const r = it instanceof Promise ? await it : it;
      for await (const e of r) events.push(e);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("simulated upstream failure");
    expect(events).toHaveLength(1);

    // Allow trace to flush.
    await new Promise((r) => setTimeout(r, 0));
    const last = getLastTrace();
    const spans = (last?.spans ?? []) as WireSpan[];
    const emitted = spans.find((s) => s.name === "anthropic-agent-sdk.agent");
    expect(emitted).toBeDefined();
    expect(emitted!.status).toBe("failed");
  });
});

/* ------------------------------------------------------------------------ */
/*  instrument / uninstall                                                   */
/* ------------------------------------------------------------------------ */

describe("instrumentClaudeAgentSDK", () => {
  it("with a client argument, behaves equivalent to wrapClaudeAgentSDK", async () => {
    const raw = happyPathClient();
    const wrapped = (await instrumentClaudeAgentSDK(raw)) as ClaudeSDKClientLike;
    expect(isClaudeAgentSDKWrapped(wrapped)).toBe(true);
    const events: SDKMessageLike[] = [];
    const it = wrapped.query("hi");
    const r = it instanceof Promise ? await it : it;
    for await (const e of r) events.push(e);
    expect(events.length).toBeGreaterThan(0);
  });

  // MHQ-936 removed the second, module-patching mode of this installer — it
  // looked for `ClaudeSDKClient.prototype.query`, a Python-only API that the
  // TS package has never exported, so it could only ever no-op. What remains
  // is the instance path; anything that isn't client-shaped returns falsy.
  it("returns a falsy value for a non-client argument, without throwing", async () => {
    expect(Boolean(await instrumentClaudeAgentSDK(undefined))).toBe(false);
    expect(Boolean(await instrumentClaudeAgentSDK({} as unknown as ClaudeSDKClientLike))).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------------ */
/*  identity v2 (MHQ-1416): the trace root is the agent                      */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDK — identity v2 (MHQ-1416)", () => {
  it("records one agent span (the root) carrying the model, outside run()", async () => {
    // @spec: MHQ-1416
    const wrapped = wrapClaudeAgentSDK(happyPathClient(), { defaultModel: "claude-opus-4-7" });
    const { spans } = await drainAndGetSpans(wrapped.query("hi"));
    const agents = spans.filter((s) => s.type === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe("claude-opus-4-7");
    expect(spans.some((s) => s.name === "anthropic-agent-sdk.agent")).toBe(false);
  });

  it("under run('app') keeps one agent: the adapter's name, with the run name as the app label", async () => {
    // @spec: MHQ-1416
    const wrapped = wrapClaudeAgentSDK(happyPathClient(), {
      defaultAgentName: "research-agent",
      defaultModel: "claude-opus-4-7",
    });
    await runAsync({ agentName: "my-app" }, async () => {
      for await (const _ of wrapped.query("hi")) void _;
    });
    const last = getLastTrace() as {
      trace: Record<string, unknown>;
      spans: WireSpan[];
    } | null;
    const agents = (last?.spans ?? []).filter((s) => s.type === "agent");
    // Before: the run's root agent plus an `anthropic-agent-sdk.agent` child.
    expect(agents).toHaveLength(1);
    expect(last?.trace.agent).toBe("research-agent");
    expect((last?.trace.metadata as Record<string, unknown> | undefined)?.morse_app).toBe("my-app");
  });

  it("a mid-iteration error still propagates and fails the trace root", async () => {
    // @spec: MHQ-1416
    class ExplodingClient implements ClaudeSDKClientLike {
      async *query(_prompt: string | unknown): AsyncIterable<SDKMessageLike> {
        void _prompt;
        yield { type: "message_start", message: { id: "msg_0" } };
        throw new Error("simulated upstream failure");
      }
    }
    const wrapped = wrapClaudeAgentSDK(new ExplodingClient());
    await expect(drainAndGetSpans(wrapped.query("hi"))).rejects.toThrow(
      "simulated upstream failure",
    );
    await new Promise((r) => setTimeout(r, 0));
    const spans = (getLastTrace()?.spans as WireSpan[] | undefined) ?? [];
    const agents = spans.filter((s) => s.type === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("failed");
  });
});
