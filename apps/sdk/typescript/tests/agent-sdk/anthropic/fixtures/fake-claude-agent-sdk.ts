/**
 * Fake `ClaudeSDKClient` for unit tests across Wave 2-A subagent tasks.
 *
 * Yields a scripted sequence of `SDKMessageLike` events that mimic a real
 * agent loop: message_start → tool_use(s) → tool_result(s) → message_stop.
 * Supports Task-tool subagent fan-out by emitting nested `task_*` events.
 *
 * Used by:
 *   - tests/agent-sdk/anthropic/client-wrapper.test.ts
 *   - tests/agent-sdk/anthropic/llm-instrumentation.test.ts
 *   - tests/agent-sdk/anthropic/tool-and-subagent.test.ts
 *   - tests/agent-sdk/anthropic/hook-instrumentation.test.ts
 *   - tests/agent-sdk/anthropic/integration.test.ts
 */

import type {
  ClaudeSDKClientLike,
  ClaudeSDKQueryOptions,
  SDKMessageLike,
} from "../../../../src/anthropic-agent-sdk/types";

export interface FakeScriptOptions {
  /** How many top-level Claude calls the agent loop should simulate. */
  llmCallCount?: number;
  /** Tool-use blocks emitted between the first and last llm call. */
  tools?: Array<{ name: string; input: unknown; output: unknown; is_error?: boolean }>;
  /** When `true`, emits a Task-tool fan-out with this many subagents. */
  subagentCount?: number;
  /** Hooks the fake will trigger (requires user to wire `client.on(...)`). */
  hooks?: Array<{ name: string; kind: "pre_tool" | "post_tool" | "on_error" }>;
  /** Token usage per llm call. */
  usagePerCall?: { input_tokens: number; output_tokens: number };
  /** Model id to report on each `message_start`. */
  model?: string;
}

export class FakeClaudeSDKClient implements ClaudeSDKClientLike {
  private readonly script: FakeScriptOptions;
  private readonly listeners = new Map<string, Set<(p: unknown) => void>>();

  constructor(script: FakeScriptOptions = {}) {
    this.script = {
      llmCallCount: 1,
      tools: [],
      subagentCount: 0,
      hooks: [],
      usagePerCall: { input_tokens: 50, output_tokens: 25 },
      model: "claude-sonnet-4-5",
      ...script,
    };
  }

  on(event: string, handler: (payload: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  private fire(event: string, payload: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(payload);
  }

  async *query(
    prompt: string | unknown,
    options?: ClaudeSDKQueryOptions,
  ): AsyncIterable<SDKMessageLike> {
    // Echo prompt + options into the script payload so callers asserting
    // on observed inputs see them; otherwise unused.
    void prompt;
    void options;
    const { llmCallCount, tools, subagentCount, hooks, usagePerCall, model } = this.script;

    for (let call = 0; call < (llmCallCount ?? 1); call++) {
      yield {
        type: "message_start",
        message: {
          id: `msg_${call}`,
          model,
          usage: { ...usagePerCall },
        },
      };

      // Fire pre_tool hooks for any tools we'll yield in this call (call 0 only
      // for the simple fixture; tasks needing finer control build their own).
      if (call === 0) {
        for (const hook of hooks ?? []) {
          if (hook.kind === "pre_tool") this.fire("hook", hook);
        }

        // Subagent fan-out (Task tool).
        for (let s = 0; s < (subagentCount ?? 0); s++) {
          yield {
            type: "tool_use",
            tool_use_id: `toolu_task_${s}`,
            name: "Task",
            input: { description: `subagent ${s}`, prompt: `do thing ${s}` },
          };
        }
        for (let s = 0; s < (subagentCount ?? 0); s++) {
          yield {
            type: "tool_result",
            tool_use_id: `toolu_task_${s}`,
            content: `subagent ${s} result`,
          };
        }

        // Regular tools.
        for (let t = 0; t < (tools ?? []).length; t++) {
          const tool = tools![t]!;
          yield {
            type: "tool_use",
            tool_use_id: `toolu_${t}`,
            name: tool.name,
            input: tool.input,
          };
        }
        for (let t = 0; t < (tools ?? []).length; t++) {
          const tool = tools![t]!;
          yield {
            type: "tool_result",
            tool_use_id: `toolu_${t}`,
            content: tool.output,
            is_error: tool.is_error ?? false,
          };
        }

        for (const hook of hooks ?? []) {
          if (hook.kind === "post_tool") this.fire("hook", hook);
        }
      }

      yield {
        type: "message_stop",
        message: {
          id: `msg_${call}`,
          model,
          usage: { ...usagePerCall },
          content: [{ type: "text", text: `response chunk ${call}` }],
        },
      };
    }

    // Error hooks at the very end (best-effort emission).
    for (const hook of hooks ?? []) {
      if (hook.kind === "on_error") this.fire("hook", hook);
    }
  }
}

/** Convenience builder for the canonical "happy path" fixture. */
export function happyPathClient(): FakeClaudeSDKClient {
  return new FakeClaudeSDKClient({
    llmCallCount: 2,
    tools: [{ name: "web_search", input: { q: "hello" }, output: "result text" }],
    subagentCount: 0,
    hooks: [],
  });
}
