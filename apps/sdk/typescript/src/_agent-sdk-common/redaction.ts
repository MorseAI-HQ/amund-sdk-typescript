/**
 * Agent-SDK-specific redaction layered on top of `_internal/redaction.ts`.
 *
 * Phase 13 W1.2. The three TS agent-SDK adapters (Anthropic Agent SDK,
 * OpenAI Agents SDK, LangGraph JS) all summarize tool inputs/outputs and
 * content blocks before stamping them onto span attributes. This module
 * provides the shared helpers they call.
 *
 * Rules (see openspec/changes/2026-05-26-phase-13-ts-agent-sdk-adapters/
 * design.md §"redaction.ts"):
 *   - Tool inputs truncated to 2 KB by default; tool outputs to 4 KB.
 *   - Base64 / data: URL blobs >= 4 KB are replaced with a hashed marker
 *     `<blob:sha256:HEX:LEN>` rather than stored inline.
 *   - Binary content blocks (image / audio / video / screenshot) are
 *     replaced by `{kind, hash, byte_len, dims?, mime?}` summaries.
 *
 * All public helpers are wrapped in `absorbErrorsSync` so they cannot
 * throw at the caller — telemetry must never break the host application.
 * On absorbed error: strings degrade to `"<redaction_error>"`,
 * `summarizeBinaryBlock` returns `null`, `redactContentBlocks` returns
 * its input unchanged.
 *
 * NB: The sha256 + canonical-JSON helpers below are duplicated from
 * `src/anthropic/index.ts` rather than imported. This is deliberate — the
 * Phase 13 W1 tasks are file-disjoint and cannot reach across into
 * `anthropic/`. The duplication is small and the algorithms are stable.
 */

import { absorbErrorsSync } from "../_internal/errors";

/* ------------------------------------------------------------------------ */
/*  Public constants                                                         */
/* ------------------------------------------------------------------------ */

export const DEFAULT_TOOL_ARG_MAX_BYTES = 2048;
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 4096;
export const DEFAULT_BLOB_TRIGGER_BYTES = 4096;

/* ------------------------------------------------------------------------ */
/*  Public types                                                             */
/* ------------------------------------------------------------------------ */

export interface SummarizeOptions {
  /** Maximum byte length of the returned string. */
  maxBytes?: number;
  /**
   * If true (default), data: URLs and >= DEFAULT_BLOB_TRIGGER_BYTES base64
   * runs are replaced with `<blob:sha256:HEX:LEN>` markers before
   * truncation. Set false to keep blobs inline (still subject to
   * truncation).
   */
  stripBlobs?: boolean;
}

export interface BinaryBlockSummary {
  kind: "image" | "audio" | "video" | "screenshot" | "binary";
  /** sha256 hex of the decoded (or, if not base64, raw) bytes. */
  hash: string;
  byte_len: number;
  dims?: { width: number; height: number };
  mime?: string;
}

/* ------------------------------------------------------------------------ */
/*  summarizeToolInput / summarizeToolOutput                                 */
/* ------------------------------------------------------------------------ */

const REDACTION_ERROR_FALLBACK = "<redaction_error>";

function summarizeImpl(value: unknown, opts: SummarizeOptions, defaultMax: number): string {
  const maxBytes = opts.maxBytes ?? defaultMax;
  const stripBlobs = opts.stripBlobs !== false;

  // Stringify with stable key order.
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (value === undefined) {
    str = "undefined";
  } else {
    str = canonicalJsonStringify(value);
  }

  if (stripBlobs) {
    str = stripBlobsFromString(str);
  }

  return truncateUtf8(str, maxBytes);
}

const summarizeToolInputInner = (value: unknown, opts?: SummarizeOptions): string =>
  summarizeImpl(value, opts ?? {}, DEFAULT_TOOL_ARG_MAX_BYTES);

const summarizeToolOutputInner = (value: unknown, opts?: SummarizeOptions): string =>
  summarizeImpl(value, opts ?? {}, DEFAULT_TOOL_OUTPUT_MAX_BYTES);

const safeSummarizeToolInput = absorbErrorsSync(summarizeToolInputInner, {
  fingerprint: "agent-sdk.redaction.summarizeToolInput",
});

const safeSummarizeToolOutput = absorbErrorsSync(summarizeToolOutputInner, {
  fingerprint: "agent-sdk.redaction.summarizeToolOutput",
});

/**
 * Reduce an arbitrary tool argument value to a small string suitable for
 * a span attribute. JSON-canonicalized (sorted keys), with optional blob
 * stripping, then truncated to `maxBytes` UTF-8 bytes.
 */
export function summarizeToolInput(value: unknown, opts?: SummarizeOptions): string {
  const out = safeSummarizeToolInput(value, opts);
  return out === undefined ? REDACTION_ERROR_FALLBACK : out;
}

/**
 * Same shape as `summarizeToolInput` but defaults to a larger byte cap
 * (`DEFAULT_TOOL_OUTPUT_MAX_BYTES`) appropriate for tool *results*.
 */
export function summarizeToolOutput(value: unknown, opts?: SummarizeOptions): string {
  const out = safeSummarizeToolOutput(value, opts);
  return out === undefined ? REDACTION_ERROR_FALLBACK : out;
}

/* ------------------------------------------------------------------------ */
/*  summarizeBinaryBlock                                                     */
/* ------------------------------------------------------------------------ */

const BINARY_KINDS: ReadonlySet<string> = new Set(["image", "audio", "video", "screenshot"]);

function summarizeBinaryBlockInner(block: unknown): BinaryBlockSummary | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : null;
  if (type === null || !BINARY_KINDS.has(type)) return null;

  const kind = type as BinaryBlockSummary["kind"];

  // Try to extract base64 payload + mime from a variety of shapes.
  let base64: string | null = null;
  let mime: string | undefined;

  // Shape 1: { source: { type: "base64", data: "...", media_type: "image/png" } }
  const source = b.source;
  if (source !== null && typeof source === "object") {
    const s = source as Record<string, unknown>;
    if (typeof s.data === "string") base64 = s.data;
    if (typeof s.media_type === "string") mime = s.media_type;
    else if (typeof s.mediaType === "string") mime = s.mediaType;
  }

  // Shape 2: { url: "data:image/jpg;base64,..." } or { dataUrl: "..." }
  if (base64 === null) {
    const url =
      typeof b.url === "string" ? b.url : typeof b.dataUrl === "string" ? b.dataUrl : null;
    if (url !== null && url.startsWith("data:")) {
      const parsed = parseDataUrl(url);
      if (parsed !== null) {
        base64 = parsed.base64;
        if (mime === undefined) mime = parsed.mime;
      }
    }
  }

  // Shape 3: raw { data: "..." } at the top level.
  if (base64 === null && typeof b.data === "string") {
    base64 = b.data;
  }

  // Dimensions (optional).
  let dims: { width: number; height: number } | undefined;
  const w = b.width;
  const h = b.height;
  if (typeof w === "number" && typeof h === "number") {
    dims = { width: w, height: h };
  }

  // Hash + length. If we have base64, decode it; otherwise hash whatever
  // string we found as bytes. If we have neither, return a zero-length
  // summary — we still know the block was a binary type.
  let hash: string;
  let byte_len: number;
  if (base64 !== null) {
    const bytes = decodeBase64ToBytes(base64);
    hash = sha256HexBytes(bytes);
    byte_len = bytes.length;
  } else {
    hash = sha256Hex("");
    byte_len = 0;
  }

  const out: BinaryBlockSummary = { kind, hash, byte_len };
  if (dims !== undefined) out.dims = dims;
  if (mime !== undefined) out.mime = mime;
  return out;
}

const safeSummarizeBinaryBlock = absorbErrorsSync(summarizeBinaryBlockInner, {
  fingerprint: "agent-sdk.redaction.summarizeBinaryBlock",
});

/**
 * Recognize a content block of type image/audio/video/screenshot and
 * return a hashed summary instead of the raw bytes. Returns null if the
 * block isn't a recognizable binary block (or on internal error).
 */
export function summarizeBinaryBlock(block: unknown): BinaryBlockSummary | null {
  const out = safeSummarizeBinaryBlock(block);
  return out === undefined ? null : out;
}

/* ------------------------------------------------------------------------ */
/*  redactContentBlocks                                                      */
/* ------------------------------------------------------------------------ */

function redactContentBlocksInner(blocks: unknown[]): unknown[] {
  return blocks.map((block) => {
    const summary = summarizeBinaryBlockInner(block);
    return summary === null ? block : summary;
  });
}

const safeRedactContentBlocks = absorbErrorsSync(redactContentBlocksInner, {
  fingerprint: "agent-sdk.redaction.redactContentBlocks",
});

/**
 * Walk a content-blocks array and replace any binary blocks with their
 * `BinaryBlockSummary`. Non-binary blocks pass through unchanged.
 */
export function redactContentBlocks(blocks: unknown[]): unknown[] {
  const out = safeRedactContentBlocks(blocks);
  return out === undefined ? blocks : out;
}

/* ------------------------------------------------------------------------ */
/*  Blob stripping                                                           */
/* ------------------------------------------------------------------------ */

/** Match `data:<mime>;base64,<payload>` URLs of any length. */
const DATA_URL_RE = /data:[A-Za-z0-9.+/-]*(?:;[A-Za-z0-9.=+/-]+)*?;base64,[A-Za-z0-9+/=]+/g;

/**
 * Match a long, unbroken run of base64 characters (no whitespace) that
 * could plausibly be a blob. The threshold here is deliberately small —
 * the byte-length check after the match decides whether it really gets
 * replaced.
 */
const LONG_BASE64_RE = /[A-Za-z0-9+/]{100,}={0,2}/g;

function stripBlobsFromString(s: string): string {
  // Pass 1: data: URLs (any length >= trigger).
  let out = s.replace(DATA_URL_RE, (match) => {
    if (match.length < DEFAULT_BLOB_TRIGGER_BYTES) return match;
    const parsed = parseDataUrl(match);
    if (parsed === null) {
      return blobMarker(sha256Hex(match), match.length);
    }
    const bytes = decodeBase64ToBytes(parsed.base64);
    return blobMarker(sha256HexBytes(bytes), bytes.length);
  });

  // Pass 2: long base64 runs not embedded in a data: URL.
  out = out.replace(LONG_BASE64_RE, (match) => {
    if (match.length < DEFAULT_BLOB_TRIGGER_BYTES) return match;
    const bytes = decodeBase64ToBytes(match);
    return blobMarker(sha256HexBytes(bytes), bytes.length);
  });

  return out;
}

function blobMarker(hashHex: string, byteLen: number): string {
  return `<blob:sha256:${hashHex}:${byteLen}>`;
}

function parseDataUrl(url: string): { mime: string; base64: string } | null {
  // data:<mime>[;params];base64,<payload>
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!header.includes("base64")) return null;
  // Strip any `;base64` and any other params.
  const parts = header.split(";");
  const mime = parts[0] !== undefined && parts[0] !== "" ? parts[0] : "application/octet-stream";
  return { mime, base64: payload };
}

/* ------------------------------------------------------------------------ */
/*  Base64 decode                                                            */
/* ------------------------------------------------------------------------ */

function decodeBase64ToBytes(b64: string): Uint8Array {
  // Strip whitespace.
  const cleaned = b64.replace(/\s+/g, "");

  // Prefer Node's Buffer.
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicRequire = Function("m", "return require(m)") as any as (m: string) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bufferMod = dynamicRequire("node:buffer") as any;
      if (bufferMod?.Buffer) {
        const buf = bufferMod.Buffer.from(cleaned, "base64") as Uint8Array;
        return new Uint8Array(buf);
      }
    }
  } catch {
    // fall through
  }

  // Browser: atob.
  try {
    if (typeof atob === "function") {
      const bin = atob(cleaned);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch {
    // fall through
  }

  // Last-resort pure-JS decoder.
  return pureBase64Decode(cleaned);
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i++) m[B64_ALPHABET[i]!] = i;
  return m;
})();

function pureBase64Decode(s: string): Uint8Array {
  const stripped = s.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]!;
    const v = B64_LOOKUP[ch];
    if (v === undefined) continue; // skip invalid
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/* ------------------------------------------------------------------------ */
/*  Canonical JSON stringify (duplicated from anthropic/index.ts)            */
/* ------------------------------------------------------------------------ */

function canonicalJsonStringify(value: unknown): string {
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
}

/* ------------------------------------------------------------------------ */
/*  UTF-8 byte truncation                                                    */
/* ------------------------------------------------------------------------ */

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // Fast path: cheap upper bound.
  if (text.length <= maxBytes / 4) return text;
  const bytes = utf8Encode(text);
  if (bytes.length <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut--;
  }
  return utf8Decode(bytes.subarray(0, cut));
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
/*  SHA-256 (duplicated from anthropic/index.ts)                             */
/* ------------------------------------------------------------------------ */

function sha256Hex(text: string): string {
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
  return purejsSha256Bytes(utf8Encode(text));
}

function sha256HexBytes(bytes: Uint8Array): string {
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicRequire = Function("m", "return require(m)") as any as (m: string) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cryptoMod = dynamicRequire("node:crypto") as any;
      if (cryptoMod?.createHash) {
        return cryptoMod.createHash("sha256").update(bytes).digest("hex");
      }
    }
  } catch {
    // fall through
  }
  return purejsSha256Bytes(bytes);
}

function purejsSha256Bytes(msg: Uint8Array): string {
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

  const msgLen = msg.length;
  const bitLen = msgLen * 8;
  const padded = new Uint8Array(((msgLen + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msgLen] = 0x80;
  // 64-bit BE length. JS bitwise ops are 32-bit, so split lo/hi via /.
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
      // `>>> 0` forces unsigned — `(byte << 24)` otherwise produces a
      // signed int when the high bit is set, which corrupts the schedule.
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
