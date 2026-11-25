/**
 * `@amund/sdk/anthropic-agent-sdk` — public surface for the
 * `@anthropic-ai/claude-agent-sdk` adapter.
 *
 * Composes the four W2-A surfaces:
 *
 *   - `client-wrapper.ts` opens the outer `agent` span around `query()`.
 *   - `llm-instrumentation.ts` taps `message_start` / `message_stop` pairs
 *     and emits `llm` spans.
 *   - `tool-and-subagent.ts` taps `tool_use` / `tool_result` pairs and
 *     emits `tool` spans (regular tools) or `agent` spans with
 *     `metadata.spawn_kind="subagent"` (Task fan-out).
 *   - `hook-instrumentation.ts` subscribes to the client's `"hook"` event
 *     channel and emits one `tool`-typed `tool_kind="hook"` span per hook.
 *
 * The convenience composer `wrapClaudeAgentSDKWithFullInstrumentation`
 * stacks them in the correct order: outer `wrapClaudeAgentSDK` opens the
 * agent span; inner generators (`instrumentLlmCalls`, `instrumentTools`)
 * are chained around the underlying query iterator so events flow once
 * through both taps before reaching the caller. Hook subscription is
 * event-based (decoupled).
 *
 * See `openspec/changes/2026-05-26-phase-13-ts-agent-sdk-adapters/`.
 */

import { wrapClaudeAgentSDK, type WrapClaudeAgentSDKOptions } from "./client-wrapper";
import {
  installHookInstrumentation,
  type InstallHookInstrumentationOptions,
} from "./hook-instrumentation";
import { instrumentLlmCalls, type InstrumentLlmCallsOptions } from "./llm-instrumentation";
import { instrumentTools, type InstrumentToolsOptions } from "./tool-and-subagent";

import type { ClaudeSDKClientLike, ClaudeSDKQueryOptions, SDKMessageLike } from "./types";

/* ------------------------------------------------------------------------ */
/*  Re-exports                                                               */
/* ------------------------------------------------------------------------ */

export type { ClaudeSDKClientLike, ClaudeSDKQueryOptions, SDKMessageLike } from "./types";

// MHQ-936: `wrapClaudeAgentQuery` is THE entry point for the real
// `@anthropic-ai/claude-agent-sdk`, whose public surface is a top-level
// `query({ prompt, options })`. The client-based exports below work for any
// object with a `.query` method but do not match the TS package's own API.
export { isClaudeAgentQueryWrapped, wrapClaudeAgentQuery } from "./query-wrapper";
export type {
  ClaudeAgentQueryFn,
  ClaudeAgentQueryLike,
  WrapClaudeAgentQueryOptions,
} from "./query-wrapper";

export {
  instrumentClaudeAgentSDK,
  isClaudeAgentSDKWrapped,
  wrapClaudeAgentSDK,
} from "./client-wrapper";
export type { WrapClaudeAgentSDKOptions } from "./client-wrapper";

export { instrumentLlmCalls } from "./llm-instrumentation";
export type { InstrumentLlmCallsOptions } from "./llm-instrumentation";

export { instrumentTools } from "./tool-and-subagent";
export type { InstrumentToolsOptions } from "./tool-and-subagent";

export { installHookInstrumentation } from "./hook-instrumentation";
export type { HookEventLike, InstallHookInstrumentationOptions } from "./hook-instrumentation";

/* ------------------------------------------------------------------------ */
/*  Composed convenience: wrapClaudeAgentSDKWithFullInstrumentation          */
/* ------------------------------------------------------------------------ */

export interface FullInstrumentationOptions
  extends
    WrapClaudeAgentSDKOptions,
    InstrumentLlmCallsOptions,
    InstrumentToolsOptions,
    InstallHookInstrumentationOptions {}

export interface FullInstrumentationResult<C extends ClaudeSDKClientLike> {
  /** The Proxy-wrapped client. Drop-in replacement for the original. */
  client: C;
  /**
   * Tear-down. Currently disconnects the hook listener. The outer-span
   * Proxy and generator wrapping are inert when not invoked, so there's
   * no other cleanup required — subsequent `query()` calls on the
   * returned client will still emit telemetry until callers drop the
   * reference.
   */
  dispose: () => void;
}

const FULL_WRAP_SENTINEL = Symbol.for("morse.anthropic-agent-sdk.full-wrapped");

interface FullWrappedMarker {
  [FULL_WRAP_SENTINEL]?: FullInstrumentationResult<ClaudeSDKClientLike>;
}

/**
 * Compose all four W2-A instrumentation layers on a single
 * `ClaudeSDKClient`. Returns the wrapped client plus a `dispose()` that
 * removes the hook listener.
 *
 * Idempotent: re-wrapping a previously full-wrapped client returns the
 * original result (same `client` reference, same `dispose`).
 *
 * Composition order (outer → inner):
 *
 *   1. `wrapClaudeAgentSDK` — opens the outer `agent` span around the
 *      whole iteration and ensures a trace is active.
 *   2. `instrumentLlmCalls` — taps `message_start` / `message_stop`
 *      pairs.
 *   3. `instrumentTools` — taps `tool_use` / `tool_result` pairs.
 *   4. The underlying `client.query()` iterator.
 *
 * `installHookInstrumentation` runs in parallel via the event channel.
 */
export function wrapClaudeAgentSDKWithFullInstrumentation<C extends ClaudeSDKClientLike>(
  client: C,
  options: FullInstrumentationOptions = {},
): FullInstrumentationResult<C> {
  // Idempotency: a client we've already full-wrapped carries the sentinel.
  const existing = (client as FullWrappedMarker)[FULL_WRAP_SENTINEL];
  if (existing) {
    return existing as FullInstrumentationResult<C>;
  }

  const wrapOpts: WrapClaudeAgentSDKOptions = {
    defaultAgentName: options.defaultAgentName,
    defaultModel: options.defaultModel,
  };
  const llmOpts: InstrumentLlmCallsOptions = {
    fallbackModel: options.defaultModel,
  };
  const toolOpts: InstrumentToolsOptions = {
    toolInputMaxBytes: options.toolInputMaxBytes,
    toolOutputMaxBytes: options.toolOutputMaxBytes,
  };
  const hookOpts: InstallHookInstrumentationOptions = {
    toolSpanLookup: options.toolSpanLookup,
  };

  // Layer 1: outer agent span via the standard wrapper.
  const outerWrapped = wrapClaudeAgentSDK(client, wrapOpts);

  // Layer 2 + 3: wrap the wrapped client's `query()` in a Proxy that
  // composes the llm + tool generators around the outer wrapper's
  // returned iterator.
  const composed = new Proxy(outerWrapped, {
    get(target, prop, receiver) {
      if (prop === "query") {
        const outerQuery = (target as ClaudeSDKClientLike).query.bind(target) as (
          prompt: string | unknown,
          options?: ClaudeSDKQueryOptions,
        ) => AsyncIterable<SDKMessageLike> | Promise<AsyncIterable<SDKMessageLike>>;

        return function composedQuery(
          prompt: string | unknown,
          callOptions?: ClaudeSDKQueryOptions,
        ): AsyncIterable<SDKMessageLike> {
          async function* compose(): AsyncGenerator<SDKMessageLike, void, unknown> {
            const ret = outerQuery(prompt, callOptions);
            const iter = (
              ret instanceof Promise ? await ret : ret
            ) as AsyncIterable<SDKMessageLike>;
            // Compose: tools wraps llm wraps the outer iterator. Order
            // between the two passthrough taps doesn't affect span
            // emission (they observe disjoint event types) but we keep
            // tools as the outermost tap so its fan-out parent snapshot
            // sees the deepest available active span.
            const llmTapped = instrumentLlmCalls(iter, { ...llmOpts, prompt });
            const toolTapped = instrumentTools(llmTapped, toolOpts);
            for await (const event of toolTapped) {
              yield event;
            }
          }
          return compose();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });

  // Layer 4: hook subscription (event-driven).
  const unsubscribeHooks = installHookInstrumentation(client, hookOpts);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribeHooks();
    } catch {
      /* never propagate */
    }
  };

  const result: FullInstrumentationResult<C> = {
    client: composed as C,
    dispose,
  };

  // Mark the original client so re-wrapping is idempotent. We tag both
  // the original and the composed proxy so callers passing either back
  // in get the same result.
  try {
    (client as FullWrappedMarker)[FULL_WRAP_SENTINEL] =
      result as FullInstrumentationResult<ClaudeSDKClientLike>;
  } catch {
    /* read-only target — best-effort idempotency only */
  }

  return result;
}
