/**
 * `_agent-sdk-common/context-decomposer.ts` — shared OpenAI-chat-format
 * context segment decomposer (MHQ-750).
 *
 * TS port of `apps/sdk/python/src/morse_ai/context/decomposer.py`'s
 * `decompose_openai_messages`. Pure functions — no I/O, no dependency on
 * `_internal/tracing.ts` or any adapter. Classifies an OpenAI chat
 * completions-shaped `messages` array (+ optional `tools` array) into
 * `ContextSegment`s so the Context & Memory dashboard can show context
 * composition without any extra customer config.
 *
 * The Anthropic adapter (`src/anthropic/index.ts`) has its own
 * `extractAnthropicSegments` because Anthropic's message format has extra
 * structure (block lists, tool_result blocks, cache_control markers). For
 * OpenAI-chat-format messages — which covers plain OpenAI chat completions,
 * LangChain, and LangGraph after message flattening — this module is the
 * canonical decomposer, mirroring the Python side's module boundary
 * (`morse_ai.context.decomposer` is called from both `adapters/openai.py`
 * and `adapters/langgraph.py`).
 *
 * Source tag mapping (mirrors the backend `SegmentSource` enum and the
 * Python decomposer's docstring):
 *
 *   role=system                                      → system_prompt
 *   tools=[...]  (the definitions array)              → tool_descriptions
 *   role=tool (OpenAI tool result)                    → tool_observation
 *   role=user / role=assistant (prior turns)          → chat_history
 *   role=user (last user turn, not a tool result)     → current_input
 *
 * Position is 0-indexed in emission order:
 *   tool_descriptions → system_prompt → chat_history/tool_observation → current_input
 *
 * Message duck-typing: accepts plain `{role, content}` dicts (OpenAI wire
 * format) AND LangChain-style message objects — either a `_getType()`
 * method (LangChain JS `BaseMessage`) or a `.type` string property. This
 * lets `decomposeOpenAiMessages` be called directly with LangGraph JS's
 * flattened `BaseMessage[]` without a translation layer, mirroring how the
 * Python decomposer duck-types LangChain's `.type` attribute.
 *
 * Never throws — malformed input returns `[]`, matching the Python
 * decomposer's `except Exception: return []` guarantee.
 */

import type { ContextSegment } from "../_internal/spans";

/* ------------------------------------------------------------------------ */
/*  Constants                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Per-segment content cap (bytes). Matches the Python decomposer's
 * `_CONTENT_BYTE_CAP` and the Anthropic TS adapter's
 * `MAX_SEGMENT_CONTENT_BYTES` so the server-side payload guard (AI-SEC-08,
 * 256 KB on `ContextSegmentIn.content`) is approached at the same rate
 * across every adapter/language.
 */
export const CONTEXT_SEGMENT_CONTENT_BYTE_CAP = 4096;

/* ------------------------------------------------------------------------ */
/*  Public types                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Structural shape of an OpenAI chat-completions-format message. Also
 * accepts LangChain-style message objects via `_getType()`/`.type`
 * duck-typing — see file header.
 */
export interface OpenAiMessageLike {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  _getType?: () => unknown;
  type?: unknown;
  [key: string]: unknown;
}

/** Structural shape of an OpenAI `tools` definition entry. */
export interface OpenAiToolLike {
  type?: string;
  function?: { name?: string; [key: string]: unknown };
  name?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------ */
/*  Public API                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Decompose an OpenAI chat-completions-shaped request into context
 * segments.
 *
 * @param messages - The `messages` array. Each element should be a
 *   `{role, content}` object, or a LangChain-style message object (see
 *   file header). Non-array input is tolerated (treated as absent).
 * @param tools - The `tools` array (list of tool definition objects).
 *   Non-array input is tolerated (treated as absent).
 * @returns `ContextSegment[]` ready for `SpanData.context_segments`.
 *   Returns `[]` (never throws) on malformed input.
 */
export function decomposeOpenAiMessages(messages?: unknown, tools?: unknown): ContextSegment[] {
  const messagesArr = Array.isArray(messages) ? (messages as OpenAiMessageLike[]) : undefined;
  const toolsArr = Array.isArray(tools) ? (tools as OpenAiToolLike[]) : undefined;

  if ((!messagesArr || messagesArr.length === 0) && (!toolsArr || toolsArr.length === 0)) {
    return [];
  }

  try {
    const segments: ContextSegment[] = [];
    let position = 0;

    // 1. tool_descriptions — one segment for the entire tools array.
    if (toolsArr && toolsArr.length > 0) {
      const toolNames: string[] = [];
      for (const t of toolsArr) {
        if (t && typeof t === "object") {
          const name = t.function?.name ?? t.name;
          if (typeof name === "string" && name.length > 0) toolNames.push(name);
        }
      }
      const toolsJson = canonicalJsonStringify(toolsArr);
      segments.push(
        makeSegment(position, "tool_descriptions", toolsJson, {
          tool_count: toolsArr.length,
          tool_names: toolNames,
        }),
      );
      position += 1;
    }

    if (!messagesArr) return segments;

    // 2. system_prompt — every system message, joined.
    const systemParts: string[] = [];
    for (const msg of messagesArr) {
      if (getRole(msg) === "system") {
        const text = contentToText(getContent(msg));
        if (text) systemParts.push(text);
      }
    }
    if (systemParts.length > 0) {
      segments.push(makeSegment(position, "system_prompt", systemParts.join("\n")));
      position += 1;
    }

    // 3. Walk non-system messages. Find the last user message that is NOT
    //    purely a tool_result (role=tool).
    const nonSystem = messagesArr.filter((m) => getRole(m) !== "system");

    let lastUserInputIdx = -1;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (getRole(nonSystem[i]) === "user") {
        lastUserInputIdx = i;
        break;
      }
    }

    for (let i = 0; i < nonSystem.length; i++) {
      const msg = nonSystem[i];
      const role = getRole(msg);
      const content = getContent(msg);

      // OpenAI tool role → tool_observation segment.
      if (role === "tool") {
        const text = contentToText(content);
        if (text) {
          const toolCallId = getAttr(msg, "tool_call_id");
          const prefix =
            typeof toolCallId === "string" && toolCallId.length > 0
              ? `[tool_result id=${toolCallId}]\n`
              : "";
          segments.push(makeSegment(position, "tool_observation", prefix + text, { role }));
          position += 1;
        }
        continue;
      }

      // Skip system (already handled).
      if (role === "system") continue;

      const text = contentToText(content);
      if (!text) continue;

      const source = role === "user" && i === lastUserInputIdx ? "current_input" : "chat_history";
      segments.push(makeSegment(position, source, text, role ? { role } : undefined));
      position += 1;
    }

    return segments;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------ */
/*  Message duck-typing helpers                                             */
/* ------------------------------------------------------------------------ */

const LC_TYPE_TO_ROLE: Record<string, string> = {
  human: "user",
  ai: "assistant",
  system: "system",
  tool: "tool",
  function: "tool",
  chat: "user",
};

function lcTypeToRole(lcType: string): string {
  return LC_TYPE_TO_ROLE[lcType.toLowerCase()] ?? lcType;
}

/**
 * Extract the `role` from a message. Plain `{role: "..."}` objects (OpenAI
 * wire format) win first; otherwise duck-types LangChain-style messages via
 * `_getType()` (LangChain JS `BaseMessage`) or a `.type` string property.
 */
/**
 * Exported for `_internal/llm-io.ts` (MHQ-858): input_data capture needs the
 * exact same message duck-typing as segment decomposition — a LangChain
 * message object has no plain `.role`, and two divergent implementations of
 * that rule is how the two features drift apart.
 */
export function getRole(msg: unknown): string {
  if (msg === null || typeof msg !== "object") return "";
  const rec = msg as OpenAiMessageLike;
  if (typeof rec.role === "string") return rec.role;
  if (typeof rec._getType === "function") {
    try {
      const t = rec._getType();
      if (typeof t === "string" && t.length > 0) return lcTypeToRole(t);
    } catch {
      // fall through
    }
  }
  if (typeof rec.type === "string" && rec.type.length > 0) return lcTypeToRole(rec.type);
  return "";
}

/** Exported alongside `getRole` — see its note. */
export function getContent(msg: unknown): unknown {
  if (msg === null || typeof msg !== "object") return undefined;
  return (msg as OpenAiMessageLike).content;
}

function getAttr(msg: unknown, attr: string): unknown {
  if (msg === null || typeof msg !== "object") return undefined;
  return (msg as Record<string, unknown>)[attr];
}

/**
 * Coerce an OpenAI message `content` value to a plain string. Content can
 * be:
 *   - string: plain text (most common)
 *   - array of parts: [{type: "text", text: "..."}, {type: "image_url", ...}]
 *   - null/undefined
 */
/** Exported alongside `getRole` — see its note. */
export function contentToText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "text") {
          parts.push(typeof p.text === "string" ? p.text : String(p.text ?? ""));
        } else if (p.type === "image_url") {
          parts.push("[image]");
        }
      } else if (typeof part === "string") {
        parts.push(part);
      }
    }
    return parts.filter((p) => p.length > 0).join("\n");
  }
  return String(content);
}

/* ------------------------------------------------------------------------ */
/*  Segment construction                                                     */
/* ------------------------------------------------------------------------ */

function makeSegment(
  position: number,
  source: string,
  content: string,
  attrs?: Record<string, unknown>,
): ContextSegment {
  const contentHash = sha256Hex(content);
  const truncated = truncateToBytes(content, CONTEXT_SEGMENT_CONTENT_BYTE_CAP);
  const seg: ContextSegment = {
    position,
    source,
    content_hash: contentHash,
    content: truncated.text,
  };
  if (truncated.truncated) seg.content_truncated = true;
  if (attrs) seg.attrs = attrs;
  return seg;
}

/**
 * Stringify with stable key ordering so equivalent objects hash to the
 * same content_hash regardless of property insertion order. Mirrors
 * Python's `json.dumps(tools, sort_keys=True, default=str)`.
 */
function canonicalJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, function replacer(_key, val) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) {
          sorted[k] = obj[k];
        }
        return sorted;
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------------ */
/*  Hashing + byte truncation (duplicated from `src/anthropic/index.ts` —
 *  see that file's equivalent block; kept module-local so this file has no
 *  cross-adapter dependency, matching the existing `_agent-sdk-common/
 *  redaction.ts` convention of a module-local SHA-256 fallback.)          */
/* ------------------------------------------------------------------------ */

function sha256Hex(text: string): string {
  // Strategy 1: Node's crypto.createHash. Sync and dep-free.
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicRequire = Function("m", "return require(m)") as any as (m: string) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cryptoMod = dynamicRequire("node:crypto") as any;
      if (cryptoMod?.createHash) {
        return cryptoMod.createHash("sha256").update(text).digest("hex");
      }
    }
  } catch {
    // fall through
  }
  // Strategy 2: pure-TS sha256 (used in browsers).
  return purejsSha256(text);
}

function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  // Fast path: cheap upper bound. 1 char ≤ 4 bytes UTF-8.
  if (text.length <= maxBytes / 4) return { text, truncated: false };
  const bytes = utf8Encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Find the largest character boundary <= maxBytes.
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut--;
  }
  return { text: utf8Decode(bytes.subarray(0, cut)), truncated: true };
}

function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text);
  }
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f),
      );
      i += 3;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/*  Pure-JS SHA-256 (used only when node:crypto is unavailable)              */
/* ------------------------------------------------------------------------ */

function purejsSha256(text: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const msg = utf8Encode(text);
  const msgLen = msg.length;
  const bitLen = msgLen * 8;
  const padded = new Uint8Array(((msgLen + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msgLen] = 0x80;
  const lo = (bitLen & 0xffffffff) >>> 0;
  const hi = Math.floor(bitLen / 0x100000000) >>> 0;
  padded[padded.length - 8] = (hi >>> 24) & 0xff;
  padded[padded.length - 7] = (hi >>> 16) & 0xff;
  padded[padded.length - 6] = (hi >>> 8) & 0xff;
  padded[padded.length - 5] = hi & 0xff;
  padded[padded.length - 4] = (lo >>> 24) & 0xff;
  padded[padded.length - 3] = (lo >>> 16) & 0xff;
  padded[padded.length - 2] = (lo >>> 8) & 0xff;
  padded[padded.length - 1] = lo & 0xff;

  const W = new Uint32Array(64);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] =
        ((padded[chunk + i * 4]! << 24) |
          (padded[chunk + i * 4 + 1]! << 16) |
          (padded[chunk + i * 4 + 2]! << 8) |
          padded[chunk + i * 4 + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + S1 + ch + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }

  let hex = "";
  for (const v of H) {
    hex += v.toString(16).padStart(8, "0");
  }
  return hex;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
