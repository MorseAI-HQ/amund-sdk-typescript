/**
 * Structural types for `@openai/agents` (OpenAI Agents SDK for TypeScript).
 *
 * No hard import — `@openai/agents` is an optional peer. Each interface
 * captures the minimum surface our `wrapRunner` and event listeners need.
 */

/** Event payload emitted by `Runner` during `run()`. */
export interface RunnerEventLike {
  type:
    | "agent_start"
    | "agent_end"
    | "llm_call_start"
    | "llm_call_end"
    | "tool_call_start"
    | "tool_call_end"
    | "handoff"
    | "guardrail_check"
    | string;
  agent?: { name?: string; model?: string; [k: string]: unknown };
  llm?: {
    model?: string;
    provider?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      [k: string]: unknown;
    };
    /**
     * OpenAI-chat-completions-shaped request messages, when the host
     * `Runner` surfaces them on the `llm_call_start` event (MHQ-750). Used
     * to populate `context_segments` via the shared
     * `_agent-sdk-common/context-decomposer`. Optional — hosts that don't
     * surface this (or an older `@openai/agents` version) simply produce
     * no context_segments, same as today.
     */
    messages?: unknown;
    /** Tool definitions bound to this LLM call, OpenAI `tools` shape. */
    tools?: unknown;
    [k: string]: unknown;
  };
  tool?: {
    name?: string;
    input?: unknown;
    output?: unknown;
    duration_ms?: number;
    success?: boolean;
    [k: string]: unknown;
  };
  handoff?: {
    from_agent?: string;
    to_agent?: string;
    reason?: string;
    [k: string]: unknown;
  };
  guardrail?: {
    name?: string;
    passed?: boolean;
    reason?: string;
    [k: string]: unknown;
  };
  error?: unknown;
  [k: string]: unknown;
}

/** Structural shape of an OpenAI Agents `Agent`. */
export interface AgentLike {
  name?: string;
  model?: string | { id?: string; [k: string]: unknown };
  instructions?: string | (() => string);
  tools?: Array<{ name?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Structural shape of a `RunResult`. */
export interface RunResultLike {
  finalOutput?: unknown;
  newItems?: Array<{ type?: string; [k: string]: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    [k: string]: unknown;
  };
  /**
   * MHQ-787: one entry per model round trip, in call order. The real SDK's
   * default (Responses API) tracing spans carry a `response_id` but no
   * `model`/`usage` of their own (see `trace-processor.ts`'s file doc) —
   * this is where that data actually lives, keyed back to a span via
   * `responseId` matching the span's `spanData.response_id`.
   */
  rawResponses?: Array<{
    responseId?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

/** Structural shape of `Runner`. */
export interface RunnerLike {
  run(agent: AgentLike, input: unknown, options?: Record<string, unknown>): Promise<RunResultLike>;
  on?(event: string, handler: (payload: RunnerEventLike) => void): void;
  off?(event: string, handler: (payload: RunnerEventLike) => void): void;
}

/** Module-shape probe for `instrumentOpenAIAgents({ openaiAgentsModule })`. */
export interface OpenAIAgentsModuleLike {
  Runner?: {
    prototype: { run: unknown; [k: string]: unknown };
  };
  run?: (...args: unknown[]) => unknown;
  default?: unknown;
  [k: string]: unknown;
}
