/**
 * `anthropic-agent-sdk/tool-and-subagent.ts` — instrument the `tool_use` /
 * `tool_result` event pairs emitted by `@anthropic-ai/claude-agent-sdk`'s
 * `ClaudeSDKClient.query()`.
 *
 * Phase 13 W2-A.3. The Anthropic Agent SDK streams a discriminated union
 * of `SDKMessage` events; this module wraps such a stream as a tap that
 * (a) passes every event through unchanged and (b) emits matching
 * Morse spans for tool invocations:
 *
 *   - `tool_use` with `name !== "Task"` → `type=tool` span (held open
 *     until the matching `tool_result` arrives, indexed by
 *     `tool_use_id`).
 *   - `tool_use` with `name === "Task"` → `type=agent` span carrying
 *     `metadata.spawn_kind="subagent"` (the canonical subagent.spawn
 *     pattern from `_agent-sdk-common/span-emitter.ts`). The span is also
 *     held open until the matching `tool_result`.
 *   - `tool_result` → look up the open span by `tool_use_id`, stamp the
 *     output summary + success flag, close with the appropriate status.
 *
 * **Task-tool fan-out parent pinning.** When the agent loop spawns more
 * than one subagent in the same turn it emits N Task `tool_use` blocks
 * sequentially before any matching `tool_result`. The default
 * top-of-stack parent lookup in `startSpan` would (incorrectly) make
 * later subagent spans children of the earlier siblings. We snapshot
 * the current top-of-stack at the first Task `tool_use` via
 * `captureParentForFanOut` and route every subagent span through
 * `emitWithPinnedParent` so they all share the same parent. The
 * snapshot is cleared once all open Task spans close (or the iterator
 * ends).
 *
 * **Error containment.** All emission is wrapped — telemetry MUST NOT
 * break iteration. If an internal helper throws, the event still flows
 * through to the caller and the offending span is best-effort skipped.
 *
 * **Orphan tolerance.** `tool_result` without a matching `tool_use` is
 * silently ignored. `tool_use` without a matching `tool_result` is
 * closed as failed when the iterator ends.
 */

import {
  captureParentForFanOut,
  emitWithPinnedParent,
  type ParentSnapshot,
} from "../_agent-sdk-common/context-propagation";
import { summarizeToolInput, summarizeToolOutput } from "../_agent-sdk-common/redaction";
import { emitToolSpan } from "../_agent-sdk-common/span-emitter";
import type { SpanHandle } from "../_internal/tracing";
import type { SDKMessageLike } from "./types";
import { report } from "../_internal/diagnostics";

const ADAPTER = "anthropic-agent-sdk" as const;
const TASK_TOOL_NAME = "Task";

export interface InstrumentToolsOptions {
  /** Override input byte cap passed to `summarizeToolInput`. */
  toolInputMaxBytes?: number;
  /** Override output byte cap passed to `summarizeToolOutput`. */
  toolOutputMaxBytes?: number;
}

interface OpenSpanEntry {
  handle: SpanHandle;
  isSubagent: boolean;
}

function safeCloseFailed(handle: SpanHandle, message: string): void {
  try {
    handle.end(new Error(message));
  } catch {
    /* never propagate */
  }
}

function safeCloseOk(handle: SpanHandle): void {
  try {
    handle.end();
  } catch {
    /* never propagate */
  }
}

/**
 * Wrap an async iterable of `SDKMessageLike` events: yield every event
 * unchanged but tap `tool_use` / `tool_result` pairs and emit matching
 * `tool` and `subagent` spans against the active Morse trace.
 *
 * No-op outside an active trace (the emitter helpers return `null`).
 * Iterator order and timing are preserved; emission errors are
 * absorbed.
 */
export async function* instrumentTools(
  events: AsyncIterable<SDKMessageLike>,
  options?: InstrumentToolsOptions,
): AsyncIterable<SDKMessageLike> {
  const open = new Map<string, OpenSpanEntry>();
  let fanOutSnapshot: ParentSnapshot | null = null;
  let openSubagentCount = 0;

  const inputOpts = options?.toolInputMaxBytes
    ? { maxBytes: options.toolInputMaxBytes }
    : undefined;
  const outputOpts = options?.toolOutputMaxBytes
    ? { maxBytes: options.toolOutputMaxBytes }
    : undefined;

  const extractContentBlocks = (event: SDKMessageLike): unknown[] => {
    const msg = (event as { message?: { content?: unknown } }).message;
    const content = msg?.content;
    return Array.isArray(content) ? content : [];
  };

  const handleToolUse = (event: SDKMessageLike): void => {
    const toolUseId = typeof event.tool_use_id === "string" ? event.tool_use_id : null;
    const name = typeof event.name === "string" ? event.name : null;
    if (toolUseId === null || name === null) return;
    if (open.has(toolUseId)) return; // duplicate id — skip

    if (name === TASK_TOOL_NAME) {
      // Subagent fan-out: snapshot the parent on the FIRST Task tool_use
      // of this fan-out, then pin every subagent span to that snapshot.
      if (fanOutSnapshot === null) {
        fanOutSnapshot = captureParentForFanOut();
      }
      const input =
        event.input && typeof event.input === "object"
          ? (event.input as Record<string, unknown>)
          : {};
      const description =
        typeof input.description === "string" && input.description.length > 0
          ? input.description
          : `subagent_${toolUseId}`;
      const taskPrompt = typeof input.prompt === "string" ? input.prompt : undefined;

      const metadata: Record<string, unknown> = {
        adapter: ADAPTER,
        spawn_kind: "subagent",
        parent_agent_name: "anthropic-agent-sdk",
        subagent_name: description,
        tool_use_id: toolUseId,
      };
      if (taskPrompt !== undefined) {
        // Reuse the same byte cap policy as tool inputs.
        metadata.task_description = summarizeToolInput(taskPrompt, inputOpts);
      }

      let handle: SpanHandle | null = null;
      try {
        if (fanOutSnapshot !== null) {
          handle = emitWithPinnedParent({
            name: `${ADAPTER}.subagent.spawn`,
            type: "agent",
            metadata,
            snapshot: fanOutSnapshot,
          });
        }
      } catch {
        handle = null;
      }
      if (handle === null) return;
      open.set(toolUseId, { handle, isSubagent: true });
      openSubagentCount++;
      return;
    }

    // Regular tool.
    let handle: SpanHandle | null = null;
    try {
      handle = emitToolSpan({
        adapter: ADAPTER,
        toolName: name,
        inputSummary: summarizeToolInput(event.input, inputOpts),
        attributes: { tool_use_id: toolUseId },
      });
    } catch {
      handle = null;
    }
    if (handle === null) return;
    open.set(toolUseId, { handle, isSubagent: false });
  };

  const handleToolResult = (event: SDKMessageLike): void => {
    const toolUseId = typeof event.tool_use_id === "string" ? event.tool_use_id : null;
    if (toolUseId === null) return;
    const entry = open.get(toolUseId);
    if (!entry) return; // orphan tolerated

    open.delete(toolUseId);
    const isError = event.is_error === true;
    try {
      const outputSummary = summarizeToolOutput(event.content, outputOpts);
      entry.handle.span.metadata = {
        ...(entry.handle.span.metadata ?? {}),
        tool_output_summary: outputSummary,
      };
      if (entry.isSubagent) {
        // Mirror the success flag on subagent metadata for UI rollup.
        (entry.handle.span.metadata as Record<string, unknown>).success = !isError;
      } else {
        // For tool spans, success lives inside metadata.tool per
        // emitToolSpan; mirror it for visibility.
        (entry.handle.span.metadata as Record<string, unknown>).success = !isError;
      }
    } catch (err) {
      /* fall through to end */
      reportSwallowed(err, "morse.anthropic_agent_sdk.tool_end");
    }
    if (isError) {
      safeCloseFailed(entry.handle, "tool error");
    } else {
      safeCloseOk(entry.handle);
    }

    if (entry.isSubagent) {
      openSubagentCount = Math.max(0, openSubagentCount - 1);
      if (openSubagentCount === 0) {
        fanOutSnapshot = null;
      }
    }
  };

  try {
    for await (const event of events) {
      try {
        const type = typeof event?.type === "string" ? event.type : null;
        if (type === "tool_use") {
          handleToolUse(event);
        } else if (type === "tool_result") {
          handleToolResult(event);
        } else if (type === "assistant" || type === "user") {
          // Real Claude Agent SDK shape: tool_use blocks live INSIDE
          // event.message.content[] (assistant) and tool_result blocks
          // live INSIDE event.message.content[] (user). Synthesize the
          // legacy-shape events and route through the same handlers.
          const blocks = extractContentBlocks(event);
          for (const block of blocks) {
            if (!block || typeof block !== "object") continue;
            const bt =
              typeof (block as { type?: unknown }).type === "string"
                ? (block as { type: string }).type
                : null;
            if (bt === "tool_use" && type === "assistant") {
              handleToolUse({
                type: "tool_use",
                tool_use_id: (block as { id?: string }).id,
                name: (block as { name?: string }).name,
                input: (block as { input?: unknown }).input,
              } as SDKMessageLike);
            } else if (bt === "tool_result" && type === "user") {
              handleToolResult({
                type: "tool_result",
                tool_use_id: (block as { tool_use_id?: string }).tool_use_id,
                content: (block as { content?: unknown }).content,
                is_error: (block as { is_error?: boolean }).is_error,
              } as SDKMessageLike);
            }
          }
        }
      } catch {
        /* never let telemetry break iteration */
      }
      yield event;
    }
  } finally {
    // Iterator ended (normal or abrupt) — fail-close any spans still
    // open. We don't know if the host loop will rerun, so cleanup here
    // is the only safe time.
    for (const [, entry] of open) {
      safeCloseFailed(entry.handle, "tool_use without matching tool_result");
      if (entry.isSubagent) {
        openSubagentCount = Math.max(0, openSubagentCount - 1);
      }
    }
    open.clear();
    fanOutSnapshot = null;
  }
}

/**
 * Route a swallowed internal error to the diagnostics channel (SDKDIAG-07).
 *
 * Control flow is unchanged — the site still swallows, still returns the same
 * value. It is simply no longer invisible to us.
 */
function reportSwallowed(err: unknown, fingerprint: string): void {
  try {
    report(err, { fingerprint });
  } catch {
    // Reporting must never break the swallow it is reporting on.
  }
}
