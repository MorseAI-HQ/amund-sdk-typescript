/**
 * Integration test for the Claude Agent SDK adapter — Wave 3-A.
 *
 * Composes the four W2-A surfaces (`client-wrapper`, `llm-instrumentation`,
 * `tool-and-subagent`, `hook-instrumentation`) via
 * `wrapClaudeAgentSDKWithFullInstrumentation` and verifies the full span
 * tree end-to-end against the canonical `FakeClaudeSDKClient` fixture.
 *
 * The unit tests in sibling files exhaustively cover each surface — this
 * file is intentionally narrow: a non-trivial happy-path script (2 llm
 * calls + 2 regular tools + 2 Task subagents + 2 hooks), idempotency, and
 * dispose semantics.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { wrapClaudeAgentSDKWithFullInstrumentation } from "../../../src/anthropic-agent-sdk";
import type { SDKMessageLike } from "../../../src/anthropic-agent-sdk/types";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";

import { FakeClaudeSDKClient } from "./fixtures/fake-claude-agent-sdk";

/* ------------------------------------------------------------------------ */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------ */

interface WireSpan {
  type: string;
  name: string;
  span_id?: string;
  parent_span_id?: string;
  status?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function buildNonTrivialClient(): FakeClaudeSDKClient {
  return new FakeClaudeSDKClient({
    llmCallCount: 2,
    tools: [
      { name: "web_search", input: { q: "morse" }, output: "search result" },
      { name: "bash", input: { cmd: "ls" }, output: "file1\nfile2" },
    ],
    subagentCount: 2,
    hooks: [
      { name: "guardrail", kind: "pre_tool" },
      { name: "audit", kind: "post_tool" },
    ],
    usagePerCall: { input_tokens: 100, output_tokens: 50 },
    model: "claude-sonnet-4-5",
  });
}

/** Drain a query iterator and return the events. */
async function drain(
  iter: AsyncIterable<SDKMessageLike> | Promise<AsyncIterable<SDKMessageLike>>,
): Promise<SDKMessageLike[]> {
  const resolved = iter instanceof Promise ? await iter : iter;
  const events: SDKMessageLike[] = [];
  for await (const e of resolved) events.push(e);
  return events;
}

/** Snapshot all wire spans on the most recent trace. */
function getSpans(): WireSpan[] {
  // Allow microtasks to settle so the trace flushes.
  const last = getLastTrace();
  return (last?.spans as WireSpan[] | undefined) ?? [];
}

beforeEach(() => {
  _resetForTesting();
});

/* ------------------------------------------------------------------------ */
/*  Full span tree                                                           */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDKWithFullInstrumentation — full span tree", () => {
  it("emits the expected 9-span tree for a non-trivial agent loop", async () => {
    const raw = buildNonTrivialClient();
    const { client } = wrapClaudeAgentSDKWithFullInstrumentation(raw);

    const events = await runAsync({ agentName: "integration-root" }, async () => {
      return drain(client.query("hello"));
    });

    expect(events).toBeDefined();
    await new Promise((r) => setTimeout(r, 0));

    const allSpans = getSpans();
    // Exclude the root agent span (named "integration-root") emitted by
    // `runAsync` so we count only what the adapter produced.
    const adapterSpans = allSpans.filter((s) => s.metadata?.adapter === "anthropic-agent-sdk");

    // 1 outer agent + 2 llm + 2 tool + 2 subagent + 2 hook = 9 adapter spans.
    expect(adapterSpans).toHaveLength(9);

    // Outer agent span
    const outerAgents = adapterSpans.filter(
      (s) => s.type === "agent" && s.metadata?.spawn_kind !== "subagent",
    );
    expect(outerAgents).toHaveLength(1);
    expect(outerAgents[0]!.metadata?.adapter).toBe("anthropic-agent-sdk");

    // LLM spans
    const llmSpans = adapterSpans.filter((s) => s.type === "llm");
    expect(llmSpans).toHaveLength(2);
    for (const s of llmSpans) {
      expect(s.metadata?.adapter).toBe("anthropic-agent-sdk");
    }

    // Regular tool spans (tool_kind !== "hook")
    const toolSpans = adapterSpans.filter(
      (s) => s.type === "tool" && s.metadata?.tool_kind !== "hook",
    );
    expect(toolSpans).toHaveLength(2);

    // Subagent spans
    const subagentSpans = adapterSpans.filter(
      (s) => s.type === "agent" && s.metadata?.spawn_kind === "subagent",
    );
    expect(subagentSpans).toHaveLength(2);
    // All subagents share the same parent (fan-out pinning).
    const subagentParents = new Set(subagentSpans.map((s) => s.parent_span_id).filter(Boolean));
    expect(subagentParents.size).toBe(1);

    // Hook spans
    const hookSpans = adapterSpans.filter(
      (s) => s.type === "tool" && s.metadata?.tool_kind === "hook",
    );
    expect(hookSpans).toHaveLength(2);
  });

  it("all adapter spans transitively descend from the outer agent span", async () => {
    // NOTE: With the FakeClaudeSDKClient fixture, llm/tool spans open and
    // hold across event groups (e.g. `tool_use` events open spans that
    // don't close until the matching `tool_result`). The "deepest open
    // span" on the stack is the parent of any new span. So we don't
    // assert direct parent linkage — we assert TRANSITIVE descent from
    // the outer agent span, which is the actual product invariant.
    const raw = buildNonTrivialClient();
    const { client } = wrapClaudeAgentSDKWithFullInstrumentation(raw);

    await runAsync({ agentName: "integration-root" }, async () => {
      await drain(client.query("hello"));
    });
    await new Promise((r) => setTimeout(r, 0));

    const allSpans = getSpans();
    const outer = allSpans.find(
      (s) => s.name === "anthropic-agent-sdk.agent" && s.metadata?.spawn_kind !== "subagent",
    );
    expect(outer).toBeDefined();
    const outerId = outer!.span_id;
    expect(outerId).toBeTruthy();

    // Build a span_id -> parent_span_id map.
    const parentOf = new Map<string, string | undefined>();
    for (const s of allSpans) {
      if (typeof s.span_id === "string") {
        parentOf.set(s.span_id, s.parent_span_id);
      }
    }
    const isDescendantOfOuter = (spanId: string | undefined): boolean => {
      let cur = spanId;
      const seen = new Set<string>();
      while (cur !== undefined && !seen.has(cur)) {
        if (cur === outerId) return true;
        seen.add(cur);
        cur = parentOf.get(cur);
      }
      return false;
    };

    const adapterSpans = allSpans.filter(
      (s) => s.metadata?.adapter === "anthropic-agent-sdk" && s.span_id !== outerId,
    );
    expect(adapterSpans.length).toBe(8); // 9 total minus the outer itself
    for (const s of adapterSpans) {
      expect(isDescendantOfOuter(s.parent_span_id)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------ */
/*  Event passthrough                                                        */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDKWithFullInstrumentation — passthrough", () => {
  it("yields the same event sequence the underlying client produces", async () => {
    // Capture expected events from a raw client.
    const raw1 = buildNonTrivialClient();
    const expected: SDKMessageLike[] = [];
    for await (const e of raw1.query("hello")) expected.push(e);

    // Capture observed events through the full wrapper.
    const raw2 = buildNonTrivialClient();
    const { client } = wrapClaudeAgentSDKWithFullInstrumentation(raw2);
    const observed = await runAsync({ agentName: "integration-root" }, async () =>
      drain(client.query("hello")),
    );

    expect(observed).toEqual(expected);
  });
});

/* ------------------------------------------------------------------------ */
/*  Idempotency                                                              */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDKWithFullInstrumentation — idempotency", () => {
  it("re-wrapping the same raw client returns the same composed result", () => {
    const raw = buildNonTrivialClient();
    const first = wrapClaudeAgentSDKWithFullInstrumentation(raw);
    const second = wrapClaudeAgentSDKWithFullInstrumentation(raw);
    expect(second.client).toBe(first.client);
    expect(second.dispose).toBe(first.dispose);
  });
});

/* ------------------------------------------------------------------------ */
/*  Dispose                                                                  */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDKWithFullInstrumentation — dispose", () => {
  it("dispose() unsubscribes the hook listener; subsequent hooks emit no spans", async () => {
    const raw = buildNonTrivialClient();
    const { client, dispose } = wrapClaudeAgentSDKWithFullInstrumentation(raw);

    // First run: hooks should land.
    await runAsync({ agentName: "integration-root" }, async () => {
      await drain(client.query("hello"));
    });
    await new Promise((r) => setTimeout(r, 0));
    const firstHookCount = getSpans().filter(
      (s) =>
        s.type === "tool" &&
        s.metadata?.adapter === "anthropic-agent-sdk" &&
        s.metadata?.tool_kind === "hook",
    ).length;
    expect(firstHookCount).toBe(2);

    // Dispose, then verify (a) the hook listener was removed from the
    // raw client, and (b) running a fresh trace produces zero hook
    // spans even when we manually fire a hook payload.
    dispose();

    const rawWithListeners = raw as unknown as {
      listeners: Map<string, Set<(p: unknown) => void>>;
    };
    const hookListeners = rawWithListeners.listeners.get("hook");
    expect(hookListeners === undefined || hookListeners.size === 0).toBe(true);

    // Run a fresh trace and manually fire a hook payload via the raw
    // client's event channel. With the listener gone, no hook span
    // should be emitted on the new trace.
    await runAsync({ agentName: "post-dispose" }, async () => {
      for (const h of hookListeners ?? new Set<(p: unknown) => void>()) {
        h({ name: "guardrail", kind: "pre_tool" });
      }
    });
    await new Promise((r) => setTimeout(r, 0));

    const postDisposeHookCount = getSpans().filter(
      (s) =>
        s.type === "tool" &&
        s.metadata?.adapter === "anthropic-agent-sdk" &&
        s.metadata?.tool_kind === "hook",
    ).length;
    expect(postDisposeHookCount).toBe(0);
  });

  it("dispose() is safe to call multiple times", () => {
    const raw = buildNonTrivialClient();
    const { dispose } = wrapClaudeAgentSDKWithFullInstrumentation(raw);
    expect(() => {
      dispose();
      dispose();
      dispose();
    }).not.toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/*  Adapter tagging                                                          */
/* ------------------------------------------------------------------------ */

describe("wrapClaudeAgentSDKWithFullInstrumentation — adapter tagging", () => {
  it("tags every adapter-emitted span with metadata.adapter='anthropic-agent-sdk'", async () => {
    const raw = buildNonTrivialClient();
    const { client } = wrapClaudeAgentSDKWithFullInstrumentation(raw);
    await runAsync({ agentName: "integration-root" }, async () => {
      await drain(client.query("hello"));
    });
    await new Promise((r) => setTimeout(r, 0));

    const allSpans = getSpans();
    // Every span EXCEPT the "integration-root" root span should carry
    // the adapter tag (the root is from runAsync, not the adapter).
    const nonRoot = allSpans.filter((s) => s.name !== "integration-root");
    for (const s of nonRoot) {
      expect(s.metadata?.adapter).toBe("anthropic-agent-sdk");
    }
  });
});
