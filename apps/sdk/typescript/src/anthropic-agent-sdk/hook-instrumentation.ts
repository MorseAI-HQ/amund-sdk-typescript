/**
 * `anthropic-agent-sdk/hook-instrumentation.ts` — W2-A.4
 *
 * Subscribes to `ClaudeSDKClient`'s `"hook"` event channel and emits one
 * `hook`-shaped span (wire `type=tool` + `metadata.tool_kind="hook"`) per
 * fired hook. Hooks logically bracket a tool invocation (`pre_tool` /
 * `post_tool`) or react to a failure (`on_error`); we therefore emit them
 * as SIBLINGS of the wrapped tool span (sharing the tool's parent), not
 * nested under it.
 *
 * When the caller provides a `toolSpanLookup` (typically wired in by the
 * tool-and-subagent W2-A.3 integration), we use `emitAsToolSibling` so
 * the hook attaches to the tool's parent. When no lookup is provided —
 * or the lookup returns null for an unknown tool_use_id — we fall back
 * to `emitHookSpan` which attaches to whatever parent is on top of the
 * active span stack.
 *
 * Hooks are synchronous from our perspective: we emit and immediately
 * close the span. When the hook payload reports `duration_ms`, it lands
 * in `metadata.hook.duration_ms` (the span's own `duration_ms` reflects
 * our emit/close roundtrip, which is effectively zero).
 *
 * Every emission is wrapped in `absorbErrorsSync` per the foundational
 * "telemetry must never break the host" guarantee.
 */

import { absorbErrorsSync } from "../_internal/errors";
import { emitAsToolSibling } from "../_agent-sdk-common/context-propagation";
import { emitHookSpan } from "../_agent-sdk-common/span-emitter";
import type { ClaudeSDKClientLike } from "./types";

/* ------------------------------------------------------------------------ */
/*  Public types                                                             */
/* ------------------------------------------------------------------------ */

export interface InstallHookInstrumentationOptions {
  /**
   * Map of toolUseId → spanId for the currently-open tool spans.
   * Provided by W2-A.3 (tool-and-subagent.ts) when the integration layer
   * composes both. When omitted, hook spans are emitted without sibling
   * linkage (they attach to whatever parent is on top of the stack).
   */
  toolSpanLookup?: (toolUseId: string) => string | null;
}

export interface HookEventLike {
  /** Hook name (user-defined identifier from their hook registration). */
  name: string;
  /** Hook kind. */
  kind: "pre_tool" | "post_tool" | "on_error";
  /** When known, the tool_use_id this hook wraps (for sibling linkage). */
  tool_use_id?: string;
  /** Duration in ms reported by the hook callback, if available. */
  duration_ms?: number;
}

/* ------------------------------------------------------------------------ */
/*  Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

function isHookEvent(payload: unknown): payload is HookEventLike {
  if (payload === null || typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) return false;
  const kind = obj.kind;
  if (kind !== "pre_tool" && kind !== "post_tool" && kind !== "on_error") return false;
  return true;
}

const _handleHookEvent = (
  payload: unknown,
  options: InstallHookInstrumentationOptions | undefined,
): void => {
  if (!isHookEvent(payload)) return;
  const { name, kind } = payload;
  const durationMs =
    typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
      ? payload.duration_ms
      : undefined;
  const toolUseId =
    typeof payload.tool_use_id === "string" && payload.tool_use_id.length > 0
      ? payload.tool_use_id
      : undefined;

  const lookup = options?.toolSpanLookup;
  const toolSpanId =
    toolUseId !== undefined && typeof lookup === "function" ? lookup(toolUseId) : null;

  if (toolSpanId !== null && toolSpanId !== undefined && toolSpanId.length > 0) {
    const hookMeta: Record<string, unknown> = { name, kind };
    if (durationMs !== undefined) hookMeta.duration_ms = durationMs;
    const handle = emitAsToolSibling({
      name: `anthropic-agent-sdk.hook.${kind}.${name}`,
      type: "tool",
      metadata: {
        adapter: "anthropic-agent-sdk",
        tool_kind: "hook",
        hook: hookMeta,
      },
      toolSpanId,
    });
    // `emitAsToolSibling` may return null when there's no active trace or
    // the tool span can't be found in the current trace. In the latter
    // case we fall back to a plain hook span so the event isn't dropped.
    if (handle !== null && handle !== undefined) {
      handle.end();
      return;
    }
  }

  const fallback = emitHookSpan({
    adapter: "anthropic-agent-sdk",
    hookName: name,
    hookKind: kind,
    durationMs,
  });
  if (fallback !== null && fallback !== undefined) {
    fallback.end();
  }
};

const handleHookEvent: (
  payload: unknown,
  options: InstallHookInstrumentationOptions | undefined,
) => void = absorbErrorsSync(_handleHookEvent, {
  fingerprint: "morse.anthropic-agent-sdk.hook-instrumentation.handle",
}) as (payload: unknown, options: InstallHookInstrumentationOptions | undefined) => void;

/* ------------------------------------------------------------------------ */
/*  Public installer                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Subscribe to the client's `"hook"` event channel and emit one hook
 * span per fired hook. Returns an unsubscribe function.
 *
 * If `client.on` is not a function (the user didn't wire hooks at all),
 * returns a no-op unsubscriber.
 */
export function installHookInstrumentation(
  client: ClaudeSDKClientLike,
  options?: InstallHookInstrumentationOptions,
): () => void {
  if (client === null || typeof client !== "object" || typeof client.on !== "function") {
    return () => {
      /* no-op */
    };
  }

  const listener = (payload: unknown): void => {
    handleHookEvent(payload, options);
  };

  try {
    client.on("hook", listener);
  } catch {
    return () => {
      /* no-op */
    };
  }

  return (): void => {
    try {
      if (typeof client.off === "function") {
        client.off("hook", listener);
      }
    } catch {
      /* swallow — telemetry must never throw at the caller */
    }
  };
}
