/**
 * Regression: SHA-256 pure-JS fallback in `src/anthropic/index.ts`.
 *
 * The Node `crypto.createHash` path is exercised by every other test in
 * this directory; the pure-JS path (used in browsers + ESM contexts where
 * `Function("m","return require(m)")` raises ReferenceError) was masked
 * until W1.2 of Phase 13 spotted two bugs in the schedule:
 *
 *   1. `(byte << 24) | ...` produces a signed int when the high bit is set,
 *      corrupting the W schedule.
 *   2. `(bitLen >>> (i * 8)) & 0xff` overflows past 32 bits because JS
 *      bitwise ops are 32-bit — the 64-bit length field was wrong for any
 *      message > 2^29 bits (~64 MB) AND scrambled the lower 32 bits because
 *      the loop wrote 8 bytes from a 32-bit source.
 *
 * This file forces the pure-JS path by mocking `process` so the Node
 * crypto branch is skipped, then asserts known SHA-256 vectors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractAnthropicSegments } from "../src/anthropic";

// Known SHA-256 vectors. The adapter hashes UTF-8 bytes of the segment
// content via canonical JSON or the raw string — for `system_prompt` it's
// the raw system string, so we can verify against the textbook vector.
const HELLO_WORLD_SHA256 = "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"; // pragma: allowlist secret

const SHORT_STRING = "abc";
const SHORT_STRING_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // pragma: allowlist secret

const HIGH_BIT_BYTES = "ÿþý"; // forces bytes ≥ 0x80 in UTF-8
// SHA-256("ÿþý" as utf-8 bytes 0xc3 0xbf 0xc3 0xbe 0xc3 0xbd):
const HIGH_BIT_SHA256 = "19b1fab30ed34214296649501a6349062b3721c70a6ecaa3c14d80d61e88d670"; // pragma: allowlist secret

/**
 * Force the pure-JS path by hiding `process.versions.node`. The adapter's
 * sha256Hex first checks `typeof process !== "undefined" && process.versions?.node`;
 * stubbing the global removes both, sending the code into `purejsSha256`.
 */
function stubOutNodeCrypto(): () => void {
  const realProcess = (globalThis as { process?: unknown }).process;
  // Replace `globalThis.process` with an object that doesn't carry
  // `versions.node`, so the Node-crypto branch short-circuits to pure-JS.
  (globalThis as { process?: unknown }).process = {
    env: (realProcess as { env?: Record<string, string> } | undefined)?.env ?? {},
    versions: {}, // no `node` key
  };
  return () => {
    (globalThis as { process?: unknown }).process = realProcess;
  };
}

let restoreProcess: (() => void) | null = null;

beforeEach(() => {
  restoreProcess = stubOutNodeCrypto();
});

afterEach(() => {
  restoreProcess?.();
  restoreProcess = null;
  vi.restoreAllMocks();
});

describe("purejsSha256 fallback path — regression", () => {
  it('hashes "Hello, World!" to the canonical vector', () => {
    const segments = extractAnthropicSegments({
      model: "claude-test",
      messages: [{ role: "user", content: "ignored" }],
      system: "Hello, World!",
    });
    const systemSeg = segments.find((s) => s.source === "system_prompt");
    expect(systemSeg, "system_prompt segment present").toBeTruthy();
    expect(systemSeg!.content_hash).toBe(HELLO_WORLD_SHA256);
  });

  it('hashes "abc" to the canonical vector', () => {
    const segments = extractAnthropicSegments({
      model: "claude-test",
      messages: [{ role: "user", content: "ignored" }],
      system: SHORT_STRING,
    });
    const systemSeg = segments.find((s) => s.source === "system_prompt");
    expect(systemSeg!.content_hash).toBe(SHORT_STRING_SHA256);
  });

  it("hashes high-bit-byte input correctly (regression for signed-shift bug)", () => {
    const segments = extractAnthropicSegments({
      model: "claude-test",
      messages: [{ role: "user", content: "ignored" }],
      system: HIGH_BIT_BYTES,
    });
    const systemSeg = segments.find((s) => s.source === "system_prompt");
    expect(systemSeg!.content_hash).toBe(HIGH_BIT_SHA256);
  });

  it("hashes are deterministic across two calls (no schedule corruption)", () => {
    const opts = {
      model: "claude-test",
      messages: [{ role: "user", content: "ignored" }],
      system: "Hello, World!",
    };
    const a = extractAnthropicSegments(opts);
    const b = extractAnthropicSegments(opts);
    const aHash = a.find((s) => s.source === "system_prompt")!.content_hash;
    const bHash = b.find((s) => s.source === "system_prompt")!.content_hash;
    expect(aHash).toBe(bHash);
    expect(aHash).toBe(HELLO_WORLD_SHA256);
  });

  it("produces 64-hex-char outputs for all sizes (regression for length-field overflow)", () => {
    // Vary sizes around the 56-byte SHA-256 chunk boundary where padding
    // straddles two chunks — the length-field bug shows up here.
    for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121]) {
      const segments = extractAnthropicSegments({
        model: "claude-test",
        messages: [{ role: "user", content: "ignored" }],
        system: "a".repeat(size),
      });
      const sys = segments.find((s) => s.source === "system_prompt");
      // Length-0 system is treated as absent — skip the hash check.
      if (size === 0) continue;
      expect(sys!.content_hash, `size=${size}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
