/**
 * MHQ-858 — shared `input_data` / `output_data` capture for LLM spans.
 *
 * Python's adapters have captured prompt/response content on `llm` spans
 * since MHQ-772; no TypeScript adapter ever did, so the trace-detail
 * INPUT/OUTPUT panes were empty for every TS customer while being populated
 * for the Python customer running the identical workload.
 *
 * Mirrors `morse_ai/adapters/anthropic.py`'s `_safe_input_messages` /
 * `_extract_output_text`, including the 4096-byte cap, so the two SDKs
 * produce the same shape for the same call.
 */

import { contentToText, getContent, getRole } from "../_agent-sdk-common/context-decomposer";

/** Bytes of text kept per field. Matches Python's `_CONTENT_BYTE_CAP`. */
export const CONTENT_BYTE_CAP = 4096;

/**
 * Truncate on a UTF-8 *byte* budget, not a UTF-16 code-unit count — a
 * 4096-char string of emoji is 16KB on the wire. Never splits a code point.
 */
export function truncateText(text: string, maxBytes: number = CONTENT_BYTE_CAP): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  // `fatal: false` replaces a trailing partial code point with U+FFFD
  // rather than throwing; drop it so the value stays clean.
  const sliced = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
  return sliced.replace(/�$/, "") + "…";
}

export interface CapturedInput {
  messages: Array<{ role?: unknown; content?: unknown }>;
  system?: string;
}

/**
 * Build a truncated, JSON-safe `input_data` from a chat-completions-shaped
 * request. String content is truncated; block-form content (tool_use,
 * tool_result, image parts) passes through as-is — per-block truncation
 * would mean reconstructing each provider's content-block schema exactly,
 * which is not worth it for a display field.
 *
 * Returns `undefined` when there is nothing worth showing, so callers can
 * assign unconditionally without writing empty objects onto the wire.
 */
export function captureInputMessages(
  messages: unknown,
  system?: unknown,
  maxBytes: number = CONTENT_BYTE_CAP,
): CapturedInput | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const safeMessages = messages
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? truncateText(m.content, maxBytes) : m.content,
    }));
  if (safeMessages.length === 0) return undefined;

  const out: CapturedInput = { messages: safeMessages };
  const systemText = flattenSystem(system);
  if (systemText) out.system = truncateText(systemText, maxBytes);
  return out;
}

/**
 * Anthropic's `system` is either a string or an array of text blocks.
 * Returns `undefined` when neither yields text.
 */
export function flattenSystem(system: unknown): string | undefined {
  if (typeof system === "string") return system || undefined;
  if (!Array.isArray(system)) return undefined;
  const parts = system
    .map((block) =>
      typeof block === "string"
        ? block
        : typeof (block as { text?: unknown })?.text === "string"
          ? (block as { text: string }).text
          : "",
    )
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Extract the assistant's text from an Anthropic `Message.content` array.
 * A response that only calls a tool still yields something meaningful
 * rather than nothing — same rule as Python's `_extract_output_text`.
 */
export function extractAnthropicOutputText(
  content: unknown,
  maxBytes: number = CONTENT_BYTE_CAP,
): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
    if (b?.type === "text" && typeof b.text === "string" && b.text) {
      parts.push(b.text);
    } else if (b?.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "tool";
      parts.push(b.input ? `[tool_use:${name}] ${safeJson(b.input)}` : `[tool_use:${name}]`);
    }
  }
  if (parts.length === 0) return undefined;
  return truncateText(parts.join("\n"), maxBytes);
}

/**
 * Extract the assistant's text from an OpenAI chat-completions response,
 * including a tool-call-only response.
 */
export function extractOpenAiOutputText(
  choices: unknown,
  maxBytes: number = CONTENT_BYTE_CAP,
): string | undefined {
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const parts: string[] = [];
  for (const choice of choices) {
    const message = (choice as { message?: Record<string, unknown> })?.message;
    if (!message) continue;
    if (typeof message.content === "string" && message.content) {
      parts.push(message.content);
    }
    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
        const name = typeof fn?.name === "string" ? fn.name : "tool";
        parts.push(
          fn?.arguments ? `[tool_call:${name}] ${String(fn.arguments)}` : `[tool_call:${name}]`,
        );
      }
    }
  }
  if (parts.length === 0) return undefined;
  return truncateText(parts.join("\n"), maxBytes);
}

/**
 * `input_data` for LangChain/LangGraph callbacks, whose messages are class
 * instances with `_getType()` rather than plain `{role, content}` dicts.
 * Reuses the decomposer's duck-typing so the two never drift.
 */
export function captureLangChainMessages(
  messages: unknown,
  maxBytes: number = CONTENT_BYTE_CAP,
): CapturedInput | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const safeMessages = messages
    .map((m) => ({ role: getRole(m) || undefined, content: contentToText(getContent(m)) }))
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role, content: truncateText(m.content, maxBytes) }));
  return safeMessages.length > 0 ? { messages: safeMessages } : undefined;
}

/** `input_data` for the raw-prompt (non-chat) LangChain LLM callback. */
export function capturePrompts(
  prompts: unknown,
  maxBytes: number = CONTENT_BYTE_CAP,
): CapturedInput | undefined {
  if (!Array.isArray(prompts) || prompts.length === 0) return undefined;
  const messages = prompts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => ({ role: "user" as const, content: truncateText(p, maxBytes) }));
  return messages.length > 0 ? { messages } : undefined;
}

/**
 * `output_data` text from a LangChain `LLMResult` — `generations` is an
 * array-of-arrays (one inner array per prompt).
 */
export function extractLangChainOutputText(
  generations: unknown,
  maxBytes: number = CONTENT_BYTE_CAP,
): string | undefined {
  if (!Array.isArray(generations)) return undefined;
  const parts: string[] = [];
  for (const group of generations) {
    if (!Array.isArray(group)) continue;
    for (const gen of group) {
      const text = (gen as { text?: unknown })?.text;
      if (typeof text === "string" && text) parts.push(text);
    }
  }
  if (parts.length === 0) return undefined;
  return truncateText(parts.join("\n"), maxBytes);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
