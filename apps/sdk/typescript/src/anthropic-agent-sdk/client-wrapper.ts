/**
 * `@amundai/sdk/anthropic-agent-sdk` — Claude Agent SDK client wrapper.
 *
 * This module implements ONLY the outer-span (agent) instrumentation around
 * `ClaudeSDKClient.query()`. Sibling files (`llm-instrumentation.ts`,
 * `tool-and-subagent.ts`, `hook-instrumentation.ts`) layer the inner llm /
 * tool / hook spans; Wave 3-A composes them via `src/anthropic-agent-sdk/index.ts`.
 *
 * Two entry points (mirroring `src/anthropic/index.ts`):
 *
 *   - `wrapClaudeAgentSDK(client)` — returns a Proxy-of-Proxy that
 *     intercepts `query()` and opens an outer `agent` span around the async
 *     iteration. The rest of the client surface (`on`, `off`, anything
 *     else) is forwarded unchanged.
 *
 *   - `instrumentClaudeAgentSDK(clientOrOptions, options?)` — two-mode
 *     installer. With a client, equivalent to `wrapClaudeAgentSDK`. With
 *     `{ claudeAgentSdkModule }`, best-effort patches
 *     `ClaudeSDKClient.prototype.query`. Always returns the wrapped client
 *     or a boolean; never throws.
 *
 * All telemetry paths are wrapped in `absorbErrors*` — a tracing failure
 * MUST NEVER break the customer's `query()`.
 */

import { absorbErrorsAsync } from "../_internal/errors";
import { getActiveTraceState, runAsync as _runAsync } from "../_internal/tracing";
import { openAgentScope } from "./agent-scope";

import type { ClaudeSDKClientLike, ClaudeSDKQueryOptions, SDKMessageLike } from "./types";

/* ------------------------------------------------------------------------ */
/*  Module-level install sentinels                                           */
/* ------------------------------------------------------------------------ */

const WRAPPED_CLIENT = Symbol.for("morse.anthropic-agent-sdk.wrapped");
/* ------------------------------------------------------------------------ */
/*  Public API                                                               */
/* ------------------------------------------------------------------------ */

export interface WrapClaudeAgentSDKOptions {
  /** Override the agent name on the outer span. Default: `"claude-agent-sdk"`. */
  defaultAgentName?: string;
  /** Override the model name passed to the outer span metadata. Default: inferred. */
  defaultModel?: string;
}

/**
 * Wrap a `ClaudeSDKClient` so each `query()` call opens an outer `agent`
 * span (via `emitAgentSpan` from `_agent-sdk-common`). The rest of the
 * client's surface is forwarded unchanged via a Proxy. Idempotent.
 *
 * THIS WRAPPER ONLY HANDLES THE OUTER AGENT SPAN. llm / tool / hook spans
 * are layered by sibling files in the same directory and composed via
 * `src/anthropic-agent-sdk/index.ts` in Wave 3.
 */
export function wrapClaudeAgentSDK<C extends ClaudeSDKClientLike>(
  client: C,
  options: WrapClaudeAgentSDKOptions = {},
): C {
  if (!client || typeof client !== "object") return client;
  // Already wrapped? Pass through.
  if ((client as Record<string | symbol, unknown>)[WRAPPED_CLIENT]) return client;

  const originalQuery = client.query?.bind(client);
  if (typeof originalQuery !== "function") return client;

  const patchedQuery = buildPatchedQuery(
    originalQuery as (
      prompt: unknown,
      options?: ClaudeSDKQueryOptions,
    ) => AsyncIterable<SDKMessageLike> | Promise<AsyncIterable<SDKMessageLike>>,
    options,
  );

  const wrapper = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLIENT) return true;
      if (prop === "query") return patchedQuery;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });

  return wrapper as C;
}

/**
 * Instance wrapper. This once had a second mode that patched
 * `ClaudeSDKClient.prototype.query` on the module. Deleted in MHQ-936 —
 * neither half of it could ever work in TypeScript:
 *
 *   - `ClaudeSDKClient` is the *Python* package's API. The TS package has
 *     never exported it (checked at 0.1.77 and 0.3.223), so the carrier
 *     lookup always returned null and the install silently no-opped.
 *   - Patching the real `query` export is impossible regardless: it is
 *     read-only and non-configurable, so assignment throws — the same wall
 *     `ai` hit in MHQ-758.
 *
 * For the real package use `wrapClaudeAgentQuery(query)` (`./query-wrapper.ts`).
 * This remains for any object exposing a `.query` method.
 *
 * Never throws; returns the wrapped client, or a falsy value otherwise.
 */
export const instrumentClaudeAgentSDK: (
  client?: ClaudeSDKClientLike,
  maybeOptions?: WrapClaudeAgentSDKOptions,
) => Promise<unknown | undefined> = absorbErrorsAsync(
  async (
    client: ClaudeSDKClientLike | undefined = undefined,
    maybeOptions: WrapClaudeAgentSDKOptions = {},
  ): Promise<unknown> => {
    if (client && isClient(client)) return wrapClaudeAgentSDK(client, maybeOptions);
    return false;
  },
  { fingerprint: "morse.adapters.anthropic-agent-sdk.install" },
);

/** True when a wrapped Claude Agent SDK client is passed in. */
export function isClaudeAgentSDKWrapped(client: unknown): boolean {
  if (!client || typeof client !== "object") return false;
  return (client as Record<string | symbol, unknown>)[WRAPPED_CLIENT] === true;
}

/* ------------------------------------------------------------------------ */
/*  Internals — module discovery                                             */
/* ------------------------------------------------------------------------ */

function isClient(x: unknown): x is ClaudeSDKClientLike {
  if (!x || typeof x !== "object") return false;
  const q = (x as { query?: unknown }).query;
  return typeof q === "function";
}

/* ------------------------------------------------------------------------ */
/*  Internals — wrapper that opens the outer `agent` span                    */
/* ------------------------------------------------------------------------ */

function buildPatchedQuery(
  original: (
    prompt: unknown,
    options?: ClaudeSDKQueryOptions,
  ) => AsyncIterable<SDKMessageLike> | Promise<AsyncIterable<SDKMessageLike>>,
  options: WrapClaudeAgentSDKOptions,
): (prompt: unknown, options?: ClaudeSDKQueryOptions) => AsyncIterable<SDKMessageLike> {
  const explicitAgentName = options.defaultAgentName;
  const defaultAgentName = explicitAgentName ?? "claude-agent-sdk";
  const defaultModel = options.defaultModel;

  return function patchedQuery(
    this: unknown,
    prompt: unknown,
    callOptions?: ClaudeSDKQueryOptions,
  ): AsyncIterable<SDKMessageLike> {
    // Capture `this` for the inner generator via Reflect.apply-style closure.
    const boundOriginal = (
      p: unknown,
      o?: ClaudeSDKQueryOptions,
    ): AsyncIterable<SDKMessageLike> | Promise<AsyncIterable<SDKMessageLike>> =>
      original.call(this, p, o);
    const model =
      (callOptions && typeof callOptions.model === "string" ? callOptions.model : undefined) ??
      defaultModel;

    async function* iterateInTrace(): AsyncGenerator<SDKMessageLike, void, unknown> {
      // Open the outer agent span BEFORE invoking the original query so the
      // model/prompt are visible to any caller that introspects the span
      // mid-iteration.
      // MHQ-1416: the trace root is the agent (no second agent span) unless legacy.
      const handle = openAgentScope({ agentName: defaultAgentName, explicitAgentName, model });
      let iter: AsyncIterable<SDKMessageLike>;
      try {
        const ret = boundOriginal(prompt, callOptions);
        iter = (ret instanceof Promise ? await ret : ret) as AsyncIterable<SDKMessageLike>;
      } catch (err) {
        handle?.end(err);
        throw err;
      }
      try {
        for await (const event of iter) {
          yield event;
        }
      } catch (err) {
        handle?.end(err);
        throw err;
      }
      handle?.end();
    }

    // If we're already inside an active trace, the agent span attaches as a
    // child of the existing root. Otherwise, open a fresh trace so the span
    // has a parent — without this, `emitAgentSpan` would no-op (return null)
    // and the customer would see no telemetry.
    if (getActiveTraceState() !== null) {
      return iterateInTrace();
    }

    // Wrap in a fresh trace. We can't simply `return _runAsync(...)` because
    // the trace must drain on iterator completion — so we tee the events out
    // via a passthrough generator and let _runAsync own the trace lifecycle.
    return (async function* outerTrace(): AsyncGenerator<SDKMessageLike, void, unknown> {
      // Buffer events into a queue and yield as they arrive. We use a
      // simple promise-based handoff to bridge the _runAsync callback's
      // for-await loop into our generator's consumer.
      const queue: Array<
        | { kind: "value"; value: SDKMessageLike }
        | { kind: "error"; error: unknown }
        | { kind: "end" }
      > = [];
      let notify: (() => void) | null = null;
      const waitForItem = (): Promise<void> =>
        new Promise((resolve) => {
          if (queue.length > 0) {
            resolve();
          } else {
            notify = (): void => {
              notify = null;
              resolve();
            };
          }
        });

      // Drive the inner generator inside _runAsync so the trace lifecycle
      // is bound to the iteration's completion.
      const runPromise = _runAsync({ agentName: explicitAgentName }, async (runHandle) => {
        try {
          for await (const event of iterateInTrace()) {
            queue.push({ kind: "value", value: event });
            notify?.();
          }
          runHandle.setOutcome(true);
        } catch (err) {
          queue.push({ kind: "error", error: err });
          notify?.();
          throw err;
        } finally {
          queue.push({ kind: "end" });
          notify?.();
        }
        return null;
      });
      // _runAsync absorbs upstream errors? No — runAsync rethrows. Catch so
      // the unhandled rejection doesn't leak; we already enqueued the error.
      runPromise.catch(() => {
        /* already handled via queue */
      });

      while (true) {
        if (queue.length === 0) await waitForItem();
        const item = queue.shift();
        if (!item) continue;
        if (item.kind === "value") {
          yield item.value;
        } else if (item.kind === "error") {
          // Drain & rethrow.
          throw item.error;
        } else {
          return;
        }
      }
    })();
  };
}
