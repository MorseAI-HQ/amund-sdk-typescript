/**
 * `@amundai/sdk/langgraph` — `MorseCallbackHandler` (W2-L.1).
 *
 * The handler is registered by LangGraph users via:
 *
 * ```ts
 * import { MorseCallbackHandler } from "@amundai/sdk/langgraph";
 * await app.invoke(input, { callbacks: [new MorseCallbackHandler()] });
 * ```
 *
 * LangGraph type-checks handlers structurally (by method presence on the
 * instance), not via `instanceof BaseCallbackHandler`. We therefore:
 *
 *   1. Always export a duck-typed class implementing `CallbackHandlerSurface`
 *      — works without `@langchain/core` installed.
 *   2. Provide `getCallbackHandlerClass()` for users who rely on
 *      `instanceof BaseCallbackHandler` — it dynamically loads
 *      `@langchain/core/callbacks/base` (optional peer dep) and returns a
 *      subclass whose prototype chain includes the real base class.
 *
 * Scope of THIS file (W2-L.1): chain spans only. `handleChainStart` opens
 * an `agent` span (the LangGraph chain IS the agent run); `handleChainEnd`
 * / `handleChainError` closes it. Nested chains nest via the per-runId
 * span map — LangGraph guarantees well-ordered start/end pairs so the
 * tracing-state span stack handles `parent_span_id` linkage for us.
 *
 * `handleLLMStart/End`, `handleToolStart/End`, and streaming callbacks
 * are implemented in W2-L.2 / W2-L.3 as separate methods on the same
 * class (composed in Wave 3-L).
 */

import { absorbErrorsSync } from "../_internal/errors";
import type { SpanHandle } from "../_internal/tracing";
import { adoptFrameworkRoot, adoptThreadId, withParentSpan } from "../_internal/tracing";
import { isLegacyIdentity } from "../_internal/agent-name";
import { emitAgentSpan, emitChainSpan } from "../_agent-sdk-common/span-emitter";
import type {
  CallbackHandlerSurface,
  LangChainCoreCallbacksModuleLike,
  SerializedLike,
} from "./types";

/* ------------------------------------------------------------------------ */
/*  Public surface                                                           */
/* ------------------------------------------------------------------------ */

export interface MorseCallbackHandlerOptions {
  /**
   * Override the agent name on the outer chain span. Falls back, in order,
   * to: `runName` (LangGraph-supplied per-invocation name), `chain.name`
   * (the serialized class name), then `"langgraph-agent"`.
   */
  defaultAgentName?: string;
}

const ADAPTER = "langgraph-js";
const HANDLER_NAME = "morse_callback_handler";
const DEFAULT_AGENT_NAME_FALLBACK = "langgraph-agent";

/**
 * Duck-typed LangGraph `BaseCallbackHandler`. Implements `CallbackHandlerSurface`
 * with chain-start / chain-end / chain-error wired to the Morse trace.
 *
 * LangGraph routes callbacks to instance methods by name; it does NOT require
 * an `instanceof` check against the real `BaseCallbackHandler`. Users who
 * need that (rare; `instanceof` checks in custom middleware) should obtain
 * the class via `getCallbackHandlerClass()` instead.
 */
export class MorseCallbackHandler implements CallbackHandlerSurface {
  /** Required by LangGraph's `BaseCallbackHandler` interface. */
  public readonly name: string = HANDLER_NAME;

  private readonly defaultAgentName: string | undefined;

  /** Open chain spans, keyed by LangGraph `runId`. */
  private readonly chainSpans: Map<string, SpanHandle> = new Map();

  constructor(options?: MorseCallbackHandlerOptions) {
    this.defaultAgentName = options?.defaultAgentName;
  }

  handleChainStart(
    chain: SerializedLike,
    _inputs: Record<string, unknown>,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    _handleChainStartImpl(this, chain, runId, runName, metadata, _parentRunId);
  }

  handleChainEnd(_outputs: Record<string, unknown>, runId: string, parentRunId?: string): void {
    void parentRunId;
    _handleChainEndImpl(this, runId);
  }

  handleChainError(err: unknown, runId: string, parentRunId?: string): void {
    void parentRunId;
    _handleChainErrorImpl(this, err, runId);
  }

  /* ------ Internal accessors used by the absorbErrorsSync-wrapped impls ----- */

  /** @internal */
  _setSpan(runId: string, handle: SpanHandle): void {
    this.chainSpans.set(runId, handle);
  }

  /** @internal — span id of an open chain, for parent attribution (AID-05). */
  _spanIdOf(runId: string | undefined): string | undefined {
    return runId === undefined ? undefined : this.chainSpans.get(runId)?.span.span_id;
  }

  /** @internal — the open handle, without removing it. */
  _peekSpan(runId: string): SpanHandle | undefined {
    return this.chainSpans.get(runId);
  }

  /** @internal */
  _defaultAgentName(): string | undefined {
    return this.defaultAgentName;
  }

  /** @internal */
  _takeSpan(runId: string): SpanHandle | undefined {
    const handle = this.chainSpans.get(runId);
    if (handle) this.chainSpans.delete(runId);
    return handle;
  }

  /** @internal */
  _resolveAgentName(chain: SerializedLike | undefined, runName: string | undefined): string {
    if (typeof runName === "string" && runName.length > 0) return runName;
    if (chain && typeof chain.name === "string" && chain.name.length > 0) return chain.name;
    if (this.defaultAgentName && this.defaultAgentName.length > 0) return this.defaultAgentName;
    return DEFAULT_AGENT_NAME_FALLBACK;
  }
}

/* ------------------------------------------------------------------------ */
/*  Implementation bodies (wrapped in absorbErrorsSync)                      */
/* ------------------------------------------------------------------------ */

const _handleChainStartImpl: (
  self: MorseCallbackHandler,
  chain: SerializedLike | undefined,
  runId: string,
  runName: string | undefined,
  metadata?: Record<string, unknown>,
  parentRunId?: string,
) => void = absorbErrorsSync(
  (
    self: MorseCallbackHandler,
    chain: SerializedLike | undefined,
    runId: string,
    runName: string | undefined,
    metadata?: Record<string, unknown>,
    parentRunId?: string,
  ) => {
    if (typeof runId !== "string" || runId.length === 0) return;
    // Defensive: if LangGraph re-fires start for the same runId, leak nothing.
    if (self._takeSpan(runId)) {
      // (we just popped it — drop on the floor; the dangling end will be a no-op)
    }
    const agentName = self._resolveAgentName(chain, runName);
    let handle: SpanHandle | null;
    if (isLegacyIdentity()) {
      handle = emitAgentSpan({ adapter: ADAPTER, agentName });
    } else {
      // AID-01/02/05: the outermost chain names the trace's root agent; every chain, that
      // one included, is a chain span parented by its callback parent, not an agent.
      if (parentRunId === undefined) adoptFrameworkRoot(self._defaultAgentName() ?? agentName);
      handle = withParentSpan(self._spanIdOf(parentRunId), () =>
        emitChainSpan({ adapter: ADAPTER, name: agentName }),
      );
    }
    if (handle) self._setSpan(runId, handle);
    // MHQ-1029: LangGraph copies `configurable.thread_id` onto the run
    // metadata, which is the only place a checkpointed conversation's
    // identity reaches a callback handler.
    if (metadata) adoptThreadId(metadata.thread_id ?? metadata.threadId);
  },
  { fingerprint: "morse.langgraph.handleChainStart" },
) as (
  self: MorseCallbackHandler,
  chain: SerializedLike | undefined,
  runId: string,
  runName: string | undefined,
  metadata?: Record<string, unknown>,
  parentRunId?: string,
) => void;

const _handleChainEndImpl: (self: MorseCallbackHandler, runId: string) => void = absorbErrorsSync(
  (self: MorseCallbackHandler, runId: string) => {
    const handle = self._takeSpan(runId);
    if (handle) handle.end();
  },
  { fingerprint: "morse.langgraph.handleChainEnd" },
) as (self: MorseCallbackHandler, runId: string) => void;

const _handleChainErrorImpl: (self: MorseCallbackHandler, err: unknown, runId: string) => void =
  absorbErrorsSync(
    (self: MorseCallbackHandler, err: unknown, runId: string) => {
      const handle = self._takeSpan(runId);
      if (handle) handle.end(err ?? new Error("langgraph chain error"));
    },
    { fingerprint: "morse.langgraph.handleChainError" },
  ) as (self: MorseCallbackHandler, err: unknown, runId: string) => void;

/* ------------------------------------------------------------------------ */
/*  Optional peer-dep: real BaseCallbackHandler                              */
/* ------------------------------------------------------------------------ */

async function loadLangChainCoreCallbacks(): Promise<LangChainCoreCallbacksModuleLike | null> {
  try {
    // Function-eval'd dynamic import keeps bundlers from trying to resolve
    // `@langchain/core/callbacks/base` at build time when the dep isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await (Function("m", "return import(m)") as any)(
      "@langchain/core/callbacks/base",
    )) as LangChainCoreCallbacksModuleLike;
    return mod ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort: if `@langchain/core/callbacks/base` is installed at runtime,
 * return an `MorseCallbackHandler`-shaped class whose prototype chain
 * includes the real `BaseCallbackHandler` (for users relying on
 * `instanceof BaseCallbackHandler` checks). Otherwise return the
 * duck-typed `MorseCallbackHandler` defined above.
 */
export async function getCallbackHandlerClass(): Promise<typeof MorseCallbackHandler> {
  const mod = await loadLangChainCoreCallbacks();
  const Base = mod?.BaseCallbackHandler;
  if (!Base) return MorseCallbackHandler;

  // Build a subclass that mixes the real Base class into the prototype chain
  // while preserving the chain-span behavior. We do this lazily so that
  // simply importing this module does NOT require `@langchain/core`.
  class MorseCallbackHandlerWithBase extends (Base as unknown as {
    new (...args: unknown[]): object;
  }) {
    public readonly name: string = HANDLER_NAME;
    private readonly _av: MorseCallbackHandler;
    constructor(options?: MorseCallbackHandlerOptions) {
      super();
      this._av = new MorseCallbackHandler(options);
    }
    handleChainStart(
      chain: SerializedLike,
      inputs: Record<string, unknown>,
      runId: string,
      parentRunId?: string,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runType?: string,
      runName?: string,
    ): void {
      this._av.handleChainStart(
        chain,
        inputs,
        runId,
        parentRunId,
        tags,
        metadata,
        runType,
        runName,
      );
    }
    handleChainEnd(outputs: Record<string, unknown>, runId: string, parentRunId?: string): void {
      this._av.handleChainEnd(outputs, runId, parentRunId);
    }
    handleChainError(err: unknown, runId: string, parentRunId?: string): void {
      this._av.handleChainError(err, runId, parentRunId);
    }
  }
  return MorseCallbackHandlerWithBase as unknown as typeof MorseCallbackHandler;
}
