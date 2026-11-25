/**
 * `wrapClaudeAgentQuery` — the supported entry point for
 * `@anthropic-ai/claude-agent-sdk` (MHQ-936).
 *
 * ## Why this replaced the client-based path
 *
 * The adapter was originally written against `ClaudeSDKClient`, a class the
 * TypeScript package has never exported — it exists in the *Python* package
 * (`claude_agent_sdk`), and the TS docs were written from those. The global
 * install path looked for `mod.ClaudeSDKClient.prototype.query`, never found
 * it, and silently did nothing; the documented `new ClaudeSDKClient(...)`
 * example threw `TypeError: ClaudeSDKClient is not a constructor`.
 *
 * The package's real surface is a top-level function, and it is the only
 * entry point stable across the versions we support — 0.1.x offered
 * `unstable_v2_createSession` as an alternative and 0.3.x removed it again,
 * while `query` was present throughout:
 *
 *     function query(params: {
 *       prompt: string | AsyncIterable<SDKUserMessage>;
 *       options?: Options;
 *     }): Query
 *
 * Note the shape: **one object argument**, not `(prompt, options)`. The old
 * wrapper's two-argument assumption was the Python signature, another symptom
 * of the same root cause.
 *
 * ## The part that is easy to get wrong
 *
 * `Query extends AsyncGenerator<SDKMessage, void>` **plus** control methods —
 * `interrupt()`, `setPermissionMode()`, and others. Wrapping it with a plain
 * `async function*` would return something that iterates correctly and has
 * quietly lost every control method: `interrupt()` becomes `undefined`, and a
 * caller relying on it fails at runtime with no hint that telemetry caused it.
 *
 * So the traced return value is a Proxy: the iteration protocol
 * (`Symbol.asyncIterator` / `next` / `return` / `throw`) is served by the
 * instrumented generator, and every other property is forwarded, bound, to
 * the real `Query`. `tests/agent-sdk/anthropic/query-wrapper.test.ts` asserts
 * that control methods survive, because losing them is invisible otherwise.
 */
import { setActiveFramework } from "../_internal/active-framework";
import { adoptThreadId } from "../_internal/tracing";
import { type AgentScope, openAgentScope } from "./agent-scope";
import { instrumentLlmCalls } from "./llm-instrumentation";
import { instrumentTools } from "./tool-and-subagent";
import { iterateInTrace } from "./trace-bridge";

import type { SDKMessageLike } from "./types";

/** The subset of `Query` we depend on: async iteration. Everything else is forwarded. */
export interface ClaudeAgentQueryLike extends AsyncIterable<SDKMessageLike> {
  [key: string]: unknown;
}

/** Real shape of the package's `query` export. One object argument. */
export type ClaudeAgentQueryFn = (params: {
  prompt: unknown;
  options?: { model?: unknown; [key: string]: unknown };
}) => ClaudeAgentQueryLike;

export interface WrapClaudeAgentQueryOptions {
  /** Agent name on the outer span when none can be derived. */
  defaultAgentName?: string;
  /** Model for the outer span when `params.options.model` is absent. */
  defaultModel?: string;
  /** Max bytes of serialized tool input captured per tool span. */
  toolInputMaxBytes?: number;
  /** Max bytes of serialized tool output captured per tool span. */
  toolOutputMaxBytes?: number;
}

const WRAPPED = Symbol.for("morse.claudeAgentQuery.wrapped");

/** True if `fn` is already a traced query — wrapping twice would double-count spans. */
export function isClaudeAgentQueryWrapped(fn: unknown): boolean {
  return typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[WRAPPED] === true;
}

/**
 * Wrap the package's `query` function. The returned function has the same
 * signature and returns a `Query`-compatible object.
 *
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { wrapClaudeAgentQuery } from "@amundai/sdk/anthropic-agent-sdk";
 *
 * const tracedQuery = wrapClaudeAgentQuery(query);
 * for await (const message of tracedQuery({ prompt: "..." })) { ... }
 * ```
 *
 * Telemetry never changes what the caller sees: messages are yielded through
 * untouched, and a throw from the underlying query propagates unchanged after
 * the span is closed with the error.
 */
export function wrapClaudeAgentQuery<Q extends ClaudeAgentQueryFn>(
  query: Q,
  options: WrapClaudeAgentQueryOptions = {},
): Q {
  if (typeof query !== "function" || isClaudeAgentQueryWrapped(query)) return query;

  const traced = function tracedQuery(
    params: Parameters<ClaudeAgentQueryFn>[0],
  ): ClaudeAgentQueryLike {
    // Call through first: the real Query carries the control methods, and we
    // must hand back something that still has them.
    const real = query(params);

    const model =
      typeof params?.options?.model === "string" ? params.options.model : options.defaultModel;

    // The agent span opens on first iteration, not here. A Query that is
    // created and never consumed should not leave a span open forever.
    let handle: AgentScope | null = null;
    let opened = false;

    async function* withAgentSpan(): AsyncGenerator<SDKMessageLike, void, unknown> {
      if (!opened) {
        opened = true;
        // MHQ-1416: traces from this adapter carried a NULL framework.
        setActiveFramework("claude-agent-sdk");
        // MHQ-1416: the trace root is the agent (no second agent span) unless legacy.
        handle = openAgentScope({
          agentName: options.defaultAgentName ?? "claude-agent-sdk",
          explicitAgentName: options.defaultAgentName,
          model,
        });
      }
      try {
        for await (const message of real) {
          // MHQ-1029: every CLI message carries the session id, and it is
          // stable across turns of one session — exactly the grouping the
          // dashboard's thread_id expresses.
          adoptThreadId((message as { session_id?: unknown } | undefined)?.session_id);
          // MHQ-1416: `options.model` is often an alias ("haiku"); the served,
          // dated model arrives on each assistant message. Record that one.
          const served = (message as { message?: { model?: unknown } } | undefined)?.message?.model;
          if (
            handle &&
            typeof served === "string" &&
            served.length > 0 &&
            handle.span.model !== served
          ) {
            handle.span.model = served;
            if (handle.span.metadata) handle.span.metadata.model = served;
          }
          yield message;
        }
      } catch (err) {
        handle?.end(err);
        handle = null;
        throw err;
      }
      handle?.end();
      handle = null;
    }

    const tapOpts = {
      toolInputMaxBytes: options.toolInputMaxBytes,
      toolOutputMaxBytes: options.toolOutputMaxBytes,
    };
    // tools wraps llm wraps the agent-span generator — same composition order
    // as the previous client path, so span nesting is unchanged.
    //
    // The whole stack runs inside iterateInTrace: without an active trace
    // emitAgentSpan no-ops and the customer sees nothing, which is exactly
    // the silent-failure mode this adapter keeps being bitten by.
    const instrumented = iterateInTrace(
      options.defaultAgentName,
      () =>
        instrumentTools(
          instrumentLlmCalls(withAgentSpan(), { fallbackModel: model, prompt: params?.prompt }),
          tapOpts,
        ) as AsyncGenerator<SDKMessageLike, void, unknown>,
    );

    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncIterator) return () => instrumented;
        if (prop === "next" || prop === "return" || prop === "throw") {
          const fn = instrumented[prop as "next" | "return" | "throw"];
          return typeof fn === "function" ? fn.bind(instrumented) : fn;
        }
        // Everything else — interrupt(), setPermissionMode(), future control
        // methods we have never heard of — goes to the real Query untouched.
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ClaudeAgentQueryLike;
  } as Q;

  Object.defineProperty(traced, WRAPPED, { value: true, enumerable: false });
  return traced;
}
