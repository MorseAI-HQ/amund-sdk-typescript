/**
 * `@morsehq-dev/sdk/langgraph` — adapter for `@langchain/langgraph` (langgraphjs).
 *
 * W3-L: composes the three W2-L surfaces into a single
 * `MorseCallbackHandler` class exposing the full
 * `BaseCallbackHandler` shape LangGraph requires:
 *
 *   - chain start/end/error  — from W2-L.1 (`callback-handler.ts`)
 *   - llm + tool start/end/error — from W2-L.2 (`llm-and-tool-callbacks.ts`)
 *   - llm new-token streaming — from W2-L.3 (`streaming-and-checkpoint.ts`)
 *
 * Users get a single class to register with LangGraph:
 *
 * ```ts
 * import { MorseCallbackHandler } from "@morsehq-dev/sdk/langgraph";
 * await app.invoke(input, { callbacks: [new MorseCallbackHandler()] });
 * ```
 *
 * The W2-L.1 base class keeps its own private map of open chain spans
 * (since it predates the shared `LangGraphRunState`). To keep things
 * coherent for advanced consumers reading `state`, the composed class
 * overrides `handleChainStart` / `handleChainEnd` / `handleChainError`
 * to ALSO maintain `state.chainSpans` in addition to calling the
 * super-class method. The base-class behavior is unchanged.
 */

import type { SpanHandle } from "../_internal/tracing";
import {
  MorseCallbackHandler as BaseMorseCallbackHandler,
  type MorseCallbackHandlerOptions,
  getCallbackHandlerClass,
} from "./callback-handler";
import {
  createLlmAndToolHandlers,
  type LangGraphRunState,
  type LlmAndToolHandlerOptions,
} from "./llm-and-tool-callbacks";
import { createStreamingHandlers, type StreamingHandlerOptions } from "./streaming-and-checkpoint";
import type { CallbackHandlerSurface, SerializedLike } from "./types";

/** Combined options for the composed handler. */
export type ComposedMorseCallbackHandlerOptions = MorseCallbackHandlerOptions &
  LlmAndToolHandlerOptions &
  StreamingHandlerOptions;

/**
 * Composed `MorseCallbackHandler` — the user-facing class.
 *
 * Inherits chain handlers from `BaseMorseCallbackHandler` (W2-L.1)
 * and attaches the W2-L.2 llm/tool methods and W2-L.3 streaming method
 * onto each instance. All four sources share a single
 * `LangGraphRunState` so future cross-method correlation can read
 * llm/tool/chain maps from one place.
 */
export class MorseCallbackHandler
  extends BaseMorseCallbackHandler
  implements CallbackHandlerSurface
{
  private readonly _state: LangGraphRunState;

  // The slotted methods from W2-L.2 / W2-L.3 — `!` because they are
  // assigned in the constructor via `Object.assign`-style copy.
  public handleLLMStart!: NonNullable<CallbackHandlerSurface["handleLLMStart"]>;
  public handleChatModelStart!: NonNullable<CallbackHandlerSurface["handleChatModelStart"]>;
  public handleLLMEnd!: NonNullable<CallbackHandlerSurface["handleLLMEnd"]>;
  public handleLLMError!: NonNullable<CallbackHandlerSurface["handleLLMError"]>;
  public handleToolStart!: NonNullable<CallbackHandlerSurface["handleToolStart"]>;
  public handleToolEnd!: NonNullable<CallbackHandlerSurface["handleToolEnd"]>;
  public handleToolError!: NonNullable<CallbackHandlerSurface["handleToolError"]>;
  public handleLLMNewToken!: NonNullable<CallbackHandlerSurface["handleLLMNewToken"]>;

  constructor(options?: ComposedMorseCallbackHandlerOptions) {
    super(options);

    this._state = {
      llmSpans: new Map<string, SpanHandle>(),
      toolSpans: new Map<string, SpanHandle>(),
      chainSpans: new Map<string, SpanHandle>(),
    };

    const llmAndTool = createLlmAndToolHandlers(this._state, {
      toolInputMaxBytes: options?.toolInputMaxBytes,
      toolOutputMaxBytes: options?.toolOutputMaxBytes,
    });
    const streaming = createStreamingHandlers(this._state, {
      trackStreamingTokens: options?.trackStreamingTokens,
    });

    // Copy method implementations onto the instance so LangGraph (which
    // looks up handlers via `typeof handler[method] === "function"` on
    // the instance) sees them. Use non-null assertions because the
    // factories always return defined methods.
    this.handleLLMStart = llmAndTool.handleLLMStart!;
    this.handleChatModelStart = llmAndTool.handleChatModelStart!;
    this.handleLLMEnd = llmAndTool.handleLLMEnd!;
    this.handleLLMError = llmAndTool.handleLLMError!;
    this.handleToolStart = llmAndTool.handleToolStart!;
    this.handleToolEnd = llmAndTool.handleToolEnd!;
    this.handleToolError = llmAndTool.handleToolError!;
    this.handleLLMNewToken = streaming.handleLLMNewToken!;
  }

  /**
   * The W2-L.1 base maintains its own private chain-span map. We
   * mirror chain handles into the shared `LangGraphRunState` so future
   * cross-fragment logic can correlate by runId. Never throws — the
   * map mutation is in-process and the super method already absorbs
   * errors via `absorbErrorsSync`.
   */
  override handleChainStart(
    chain: SerializedLike,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
  ): void {
    super.handleChainStart(chain, inputs, runId, parentRunId, tags, metadata, runType, runName);
    // Mirror — read the now-open span from the base via the internal
    // accessor used in tests, then re-insert it (the base `_takeSpan`
    // deletes on read, so we'd break the base if we used it here).
    // Instead reach into the base via the public-ish `_setSpan` would
    // double-insert; safer to keep our own shadow keyed off the same
    // runId.
    this._shadowSetChainSpan(runId);
  }

  override handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
  ): void {
    super.handleChainEnd(outputs, runId, parentRunId);
    this._state.chainSpans.delete(runId);
  }

  override handleChainError(err: unknown, runId: string, parentRunId?: string): void {
    super.handleChainError(err, runId, parentRunId);
    this._state.chainSpans.delete(runId);
  }

  /**
   * Marker insertion for the shared chainSpans map. The W2-L.1 base
   * holds the real `SpanHandle` privately; for the shared map we just
   * need *presence* keyed by runId so downstream fragments can detect
   * an in-flight chain. We stash a sentinel handle whose `end()` is a
   * no-op — the base owns the real lifecycle.
   */
  private _shadowSetChainSpan(runId: string): void {
    if (typeof runId !== "string" || runId.length === 0) return;
    // AID-05: the real handle, so llm/tool callbacks can read the chain's span id as
    // their parent. Never ended through this map; the base owns the lifecycle.
    const handle = this._peekSpan(runId);
    if (handle) this._state.chainSpans.set(runId, handle);
  }
}

/* ------------------------------------------------------------------------ */
/*  Re-exports                                                               */
/* ------------------------------------------------------------------------ */

// Low-level pieces for advanced users who want to compose their own
// handler shape.
export { BaseMorseCallbackHandler };
export { getCallbackHandlerClass };
export { createLlmAndToolHandlers } from "./llm-and-tool-callbacks";
export { createStreamingHandlers } from "./streaming-and-checkpoint";

export type {
  MorseCallbackHandlerOptions,
  LangGraphRunState,
  LlmAndToolHandlerOptions,
  StreamingHandlerOptions,
};

export type {
  BaseMessageLike,
  CallbackHandlerSurface,
  LangChainCoreCallbacksModuleLike,
  LLMResultLike,
  SerializedLike,
} from "./types";
