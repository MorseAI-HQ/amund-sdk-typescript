/**
 * Structural types for `@anthropic-ai/claude-agent-sdk` integration.
 *
 * We deliberately decline to import the real types so the SDK works even
 * when `@anthropic-ai/claude-agent-sdk` isn't installed. Each interface
 * captures the minimum surface our wrappers need to observe.
 *
 * Mirrors the pattern in `src/anthropic/index.ts` (low-level Messages
 * API adapter) and `src/openai-agents/types.ts` / `src/langgraph/types.ts`.
 */

import type { AnthropicMessageCreateParams } from "../anthropic";

/**
 * One SDK event yielded from `ClaudeSDKClient.query()`. The real SDK emits
 * an `SDKMessage` discriminated union; we keep the structural shape minimal.
 */
export interface SDKMessageLike {
  type: string; // "message_start" | "message_stop" | "tool_use" | "tool_result" | ...
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      [k: string]: unknown;
    };
    content?: Array<{ type: string; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  // tool_use / tool_result events
  tool_use_id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  // hook events (optional surface — user may not wire hooks at all)
  hook?: {
    name: string;
    kind: "pre_tool" | "post_tool" | "on_error";
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface ClaudeSDKQueryOptions {
  systemPrompt?: string;
  maxTurns?: number;
  model?: string;
  // permissionMode, allowedTools, mcpServers, etc — pass-through
  [k: string]: unknown;
}

/**
 * Structural shape of `ClaudeSDKClient`. We only require `query()` returning
 * an async iterable of `SDKMessageLike`. Hook registration is optional and
 * accessed via `client.on(...)` if present.
 */
export interface ClaudeSDKClientLike {
  query(
    prompt: string | AnthropicMessageCreateParams,
    options?: ClaudeSDKQueryOptions,
  ): AsyncIterable<SDKMessageLike> | Promise<AsyncIterable<SDKMessageLike>>;
  on?(event: string, handler: (payload: unknown) => void): void;
  off?(event: string, handler: (payload: unknown) => void): void;
}

/** Re-export low-level message types for downstream emitter convenience. */
export type { AnthropicMessageCreateParams, AnthropicMessageResponse } from "../anthropic";
