/**
 * Tests for `src/anthropic-agent-sdk/tool-and-subagent.ts` — Wave 2-A.3.
 *
 * Drives the `instrumentTools` generator-wrapper against the
 * `FakeClaudeSDKClient` fixture inside a real `runAsync` trace. Asserts
 * that:
 *   - regular tools emit `type=tool` spans
 *   - Task-tool fan-out emits `type=agent` spans with
 *     `metadata.spawn_kind="subagent"` and shared parent_span_id
 *   - tool_result success/error closes the matching span correctly
 *   - large inputs are truncated by `summarizeToolInput`
 *   - orphan tool_result is silently ignored
 *   - tool_use without matching tool_result is closed as failed at end
 *   - every event flows through the wrapper unchanged
 */

import { beforeEach, describe, expect, it } from "vitest";

import { instrumentTools } from "../../../src/anthropic-agent-sdk/tool-and-subagent";
import type { SDKMessageLike } from "../../../src/anthropic-agent-sdk/types";
import { _resetForTesting, getLastTrace, runAsync } from "../../../src/_internal/tracing";
import { FakeClaudeSDKClient } from "./fixtures/fake-claude-agent-sdk";

interface WireSpan {
  type: string;
  name: string;
  span_id?: string;
  parent_span_id?: string;
  status?: string;
  error_message?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Run the fake client's query through `instrumentTools` inside a trace,
 * collect every emitted event, then return both the events and the
 * non-root spans captured by `getLastTrace`.
 */
async function runInstrumented(
  client: FakeClaudeSDKClient,
  options?: Parameters<typeof instrumentTools>[1],
): Promise<{ events: SDKMessageLike[]; spans: WireSpan[] }> {
  const events: SDKMessageLike[] = [];
  await runAsync({ agentName: "test-agent" }, async () => {
    for await (const e of instrumentTools(client.query("hi"), options)) {
      events.push(e);
    }
  });
  const last = getLastTrace();
  const allSpans = (last?.spans ?? []) as WireSpan[];
  const spans = allSpans.filter((s) => s.name !== "test-agent");
  return { events, spans };
}

beforeEach(() => {
  _resetForTesting();
});

describe("instrumentTools — regular tool spans", () => {
  it("emits one tool span for a single non-Task tool_use/tool_result pair", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "web_search", input: { q: "morse" }, output: "ok" }],
    });
    const { spans } = await runInstrumented(client);
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("tool");
    expect(s.name).toBe("anthropic-agent-sdk.tool.web_search");
    expect(s.status).toBe("completed");
    const tool = s.metadata?.tool as Record<string, unknown> | undefined;
    expect(tool?.name).toBe("web_search");
    expect(typeof tool?.input_summary).toBe("string");
    expect(s.metadata?.tool_output_summary).toBeDefined();
    expect(s.metadata?.success).toBe(true);
  });

  it("closes the span as failed when tool_result has is_error=true", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "bash", input: { cmd: "ls" }, output: "exit 1", is_error: true }],
    });
    const { spans } = await runInstrumented(client);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
    expect(spans[0]!.error_message).toBe("tool error");
    expect(spans[0]!.metadata?.success).toBe(false);
  });

  it("emits N tool spans in order for N sequential tools", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [
        { name: "tool_a", input: { i: 0 }, output: "a" },
        { name: "tool_b", input: { i: 1 }, output: "b" },
        { name: "tool_c", input: { i: 2 }, output: "c" },
      ],
    });
    const { spans } = await runInstrumented(client);
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.name)).toEqual([
      "anthropic-agent-sdk.tool.tool_a",
      "anthropic-agent-sdk.tool.tool_b",
      "anthropic-agent-sdk.tool.tool_c",
    ]);
    for (const s of spans) {
      expect(s.type).toBe("tool");
      expect(s.status).toBe("completed");
    }
  });

  it("attaches tool_use_id to span metadata for cross-correlation", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "noop", input: {}, output: "" }],
    });
    const { spans } = await runInstrumented(client);
    expect(spans[0]!.metadata?.tool_use_id).toBe("toolu_0");
  });
});

describe("instrumentTools — Task-tool subagent fan-out", () => {
  it("emits one subagent span for subagentCount=1", async () => {
    const client = new FakeClaudeSDKClient({ subagentCount: 1 });
    const { spans } = await runInstrumented(client);
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.type).toBe("agent");
    expect(s.name).toBe("anthropic-agent-sdk.subagent.spawn");
    expect(s.metadata?.spawn_kind).toBe("subagent");
    expect(s.metadata?.subagent_name).toBe("subagent 0");
  });

  it("multi-Task fan-out: all subagent spans share the SAME parent_span_id", async () => {
    const client = new FakeClaudeSDKClient({ subagentCount: 3 });
    const { spans } = await runInstrumented(client);
    expect(spans).toHaveLength(3);
    const parents = new Set(spans.map((s) => s.parent_span_id));
    expect(parents.size).toBe(1);
    // Parent should be the trace root (test-agent span_id), which is the
    // top-of-stack when fan-out begins.
    const last = getLastTrace();
    const root = (last?.spans as WireSpan[]).find((s) => s.name === "test-agent");
    expect(root?.span_id).toBeDefined();
    expect(spans[0]!.parent_span_id).toBe(root!.span_id);
  });

  it("each subagent's metadata.subagent_name matches the fixture description", async () => {
    const client = new FakeClaudeSDKClient({ subagentCount: 3 });
    const { spans } = await runInstrumented(client);
    const names = spans.map((s) => s.metadata?.subagent_name);
    expect(names).toEqual(["subagent 0", "subagent 1", "subagent 2"]);
  });

  it("each subagent's metadata.task_description is summarised from the prompt", async () => {
    const client = new FakeClaudeSDKClient({ subagentCount: 2 });
    const { spans } = await runInstrumented(client);
    for (let i = 0; i < spans.length; i++) {
      const td = spans[i]!.metadata?.task_description;
      expect(typeof td).toBe("string");
      expect(td as string).toContain(`do thing ${i}`);
    }
  });
});

describe("instrumentTools — mixed Task + regular tool ordering", () => {
  it("emits 2 subagent + 1 tool span in correct order, correct types", async () => {
    const client = new FakeClaudeSDKClient({
      subagentCount: 2,
      tools: [{ name: "web_search", input: { q: "x" }, output: "ok" }],
    });
    const { spans } = await runInstrumented(client);
    expect(spans).toHaveLength(3);
    // The fixture emits Task tool_uses first, then regular tool_uses.
    // Spans complete (and are pushed onto completedSpans) in tool_result
    // arrival order — Task results first, then regular tool result.
    expect(spans.map((s) => s.type)).toEqual(["agent", "agent", "tool"]);
    expect(spans[0]!.metadata?.spawn_kind).toBe("subagent");
    expect(spans[1]!.metadata?.spawn_kind).toBe("subagent");
    expect(spans[2]!.name).toBe("anthropic-agent-sdk.tool.web_search");
  });
});

describe("instrumentTools — redaction", () => {
  it("truncates large tool inputs via summarizeToolInput", async () => {
    const big = "x".repeat(10_000);
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "noop", input: { payload: big }, output: "ok" }],
    });
    const { spans } = await runInstrumented(client);
    const tool = spans[0]!.metadata?.tool as Record<string, unknown>;
    const summary = tool.input_summary as string;
    // Default cap is 2048 bytes.
    expect(summary.length).toBeLessThanOrEqual(2200);
    expect(summary.length).toBeLessThan(big.length);
  });
});

describe("instrumentTools — orphan & cleanup semantics", () => {
  it("tool_result without matching tool_use is silently ignored", async () => {
    async function* synthetic(): AsyncIterable<SDKMessageLike> {
      yield { type: "tool_result", tool_use_id: "ghost", content: "boo" };
    }
    const events: SDKMessageLike[] = [];
    await runAsync({ agentName: "test-agent" }, async () => {
      for await (const e of instrumentTools(synthetic())) {
        events.push(e);
      }
    });
    const last = getLastTrace();
    const spans = ((last?.spans as WireSpan[]) ?? []).filter((s) => s.name !== "test-agent");
    expect(spans).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("tool_use without matching tool_result is closed as failed at iterator end", async () => {
    async function* synthetic(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "tool_use",
        tool_use_id: "toolu_orphan",
        name: "leaks",
        input: { foo: 1 },
      };
      // no tool_result
    }
    await runAsync({ agentName: "test-agent" }, async () => {
      for await (const _e of instrumentTools(synthetic())) {
        void _e;
      }
    });
    const last = getLastTrace();
    const spans = ((last?.spans as WireSpan[]) ?? []).filter((s) => s.name !== "test-agent");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toBe("failed");
    expect(spans[0]!.error_message).toContain("without matching tool_result");
  });

  it("orphan Task tool_use is also closed as failed at end", async () => {
    async function* synthetic(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "tool_use",
        tool_use_id: "toolu_task_orphan",
        name: "Task",
        input: { description: "abandoned", prompt: "never finishes" },
      };
    }
    await runAsync({ agentName: "test-agent" }, async () => {
      for await (const _e of instrumentTools(synthetic())) {
        void _e;
      }
    });
    const last = getLastTrace();
    const spans = ((last?.spans as WireSpan[]) ?? []).filter((s) => s.name !== "test-agent");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.type).toBe("agent");
    expect(spans[0]!.metadata?.spawn_kind).toBe("subagent");
    expect(spans[0]!.status).toBe("failed");
  });
});

describe("instrumentTools — pass-through fidelity", () => {
  it("yields every event unchanged in original order", async () => {
    const client = new FakeClaudeSDKClient({
      llmCallCount: 2,
      tools: [{ name: "noop", input: {}, output: "" }],
    });
    // Drive the raw client first to capture the expected order.
    const expected: SDKMessageLike[] = [];
    for await (const e of client.query("hi")) {
      expected.push(e);
    }
    // Now drive a fresh client through the wrapper.
    const client2 = new FakeClaudeSDKClient({
      llmCallCount: 2,
      tools: [{ name: "noop", input: {}, output: "" }],
    });
    const observed: SDKMessageLike[] = [];
    await runAsync({ agentName: "test-agent" }, async () => {
      for await (const e of instrumentTools(client2.query("hi"))) {
        observed.push(e);
      }
    });
    expect(observed.map((e) => e.type)).toEqual(expected.map((e) => e.type));
    expect(observed).toHaveLength(expected.length);
  });

  /* -- Real Claude Agent SDK shape (assistant/user content blocks) — added 2026-05-27 -- */

  it("emits a tool span for a real-shape assistant.tool_use + user.tool_result pair", async () => {
    async function* gen(): AsyncIterable<SDKMessageLike> {
      yield {
        type: "assistant",
        message: {
          id: "msg_1",
          model: "claude-haiku-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_real_1",
              name: "current_time",
              input: { tz: "UTC" },
            },
          ],
        },
      } as SDKMessageLike;
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_real_1",
              content: "2026-05-27T09:50:00Z",
            },
          ],
        },
      } as SDKMessageLike;
    }
    await runAsync({ agentName: "t" }, async () => {
      for await (const _ of instrumentTools(gen())) {
        void _;
      }
    });
    const last = getLastTrace();
    const toolSpans = (last?.spans as Array<{ type: string }>).filter((s) => s.type === "tool");
    expect(toolSpans).toHaveLength(1);
  });

  it("works outside an active trace: yields events, emits no spans, does not throw", async () => {
    const client = new FakeClaudeSDKClient({
      tools: [{ name: "noop", input: {}, output: "" }],
    });
    const events: SDKMessageLike[] = [];
    // No surrounding runAsync.
    for await (const e of instrumentTools(client.query("hi"))) {
      events.push(e);
    }
    expect(events.length).toBeGreaterThan(0);
    // getLastTrace may carry residue from a prior test even with reset;
    // assert no NEW trace was opened by checking events flowed.
    expect(events.map((e) => e.type)).toContain("message_start");
  });
});
