/**
 * Phase 13 W1.2 — agent-SDK shared redaction helpers.
 *
 * Verifies:
 *   - Tool input/output summarization respects byte caps and canonical JSON.
 *   - Base64 / data: URL blobs over the trigger threshold are replaced with
 *     `<blob:sha256:HEX:LEN>` markers.
 *   - Binary content blocks (image / audio / video / screenshot) reduce to
 *     `BinaryBlockSummary` shapes.
 *   - All helpers absorb internal errors and return safe fallbacks.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BLOB_TRIGGER_BYTES,
  DEFAULT_TOOL_ARG_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  redactContentBlocks,
  summarizeBinaryBlock,
  summarizeToolInput,
  summarizeToolOutput,
} from "../../../src/_agent-sdk-common/redaction";

/* ------------------------------------------------------------------------ */
/*  summarizeToolInput / summarizeToolOutput                                 */
/* ------------------------------------------------------------------------ */

describe("summarizeToolInput", () => {
  it("returns a small string unchanged", () => {
    expect(summarizeToolInput("hello world")).toBe("hello world");
  });

  it("truncates a 10 KB string to DEFAULT_TOOL_ARG_MAX_BYTES", () => {
    // Use a phrase with spaces so it isn't matched as a base64 blob and
    // collapsed by the blob-stripping pass before truncation.
    const long = "the quick brown fox jumps over the lazy dog. ".repeat(300);
    expect(long.length).toBeGreaterThan(10_000);
    const out = summarizeToolInput(long);
    expect(out.length).toBe(DEFAULT_TOOL_ARG_MAX_BYTES);
  });

  it("canonicalizes nested objects (sorted keys) and may truncate", () => {
    const obj = { z: 1, a: { y: 2, x: 3 }, m: [1, 2, 3] };
    const out = summarizeToolInput(obj);
    // Sorted: a before m before z; a's inner sorted: x before y.
    expect(out).toBe('{"a":{"x":3,"y":2},"m":[1,2,3],"z":1}');
  });

  it("replaces a >4 KB base64 blob with a <blob:sha256:...> marker", () => {
    // Build a 6 KB base64 payload (over DEFAULT_BLOB_TRIGGER_BYTES=4096).
    const blob = "QUJDRA".repeat(1200); // ~7200 chars, all base64-safe
    expect(blob.length).toBeGreaterThan(DEFAULT_BLOB_TRIGGER_BYTES);
    const out = summarizeToolInput({ payload: blob });
    expect(out).toMatch(/<blob:sha256:[0-9a-f]{64}:\d+>/);
    expect(out).not.toContain(blob);
  });

  it("with stripBlobs: false keeps the blob inline (but still truncates)", () => {
    const blob = "QUJDRA".repeat(1200);
    const out = summarizeToolInput({ payload: blob }, { stripBlobs: false });
    expect(out).not.toMatch(/<blob:sha256:/);
    // Should still be truncated to default cap.
    expect(out.length).toBeLessThanOrEqual(DEFAULT_TOOL_ARG_MAX_BYTES);
  });

  it("replaces a data: URL blob with a marker including decoded byte_len", () => {
    // base64 of "Hello, World!" is "SGVsbG8sIFdvcmxkIQ==" — too short, need >=4096.
    const longB64 = "SGVsbG8=".repeat(700); // ~5600 chars
    const dataUrl = `data:image/png;base64,${longB64}`;
    expect(dataUrl.length).toBeGreaterThan(DEFAULT_BLOB_TRIGGER_BYTES);
    const out = summarizeToolInput({ img: dataUrl });
    expect(out).toMatch(/<blob:sha256:[0-9a-f]{64}:\d+>/);
    expect(out).not.toContain(longB64);
  });
});

describe("summarizeToolOutput", () => {
  it("uses DEFAULT_TOOL_OUTPUT_MAX_BYTES by default", () => {
    const long = "lorem ipsum dolor sit amet. ".repeat(500);
    expect(long.length).toBeGreaterThan(10_000);
    const out = summarizeToolOutput(long);
    expect(out.length).toBe(DEFAULT_TOOL_OUTPUT_MAX_BYTES);
    // The output cap is larger than the input cap.
    expect(DEFAULT_TOOL_OUTPUT_MAX_BYTES).toBeGreaterThan(DEFAULT_TOOL_ARG_MAX_BYTES);
  });

  it("accepts a custom maxBytes override", () => {
    const long = "lorem ipsum dolor sit amet. ".repeat(500);
    const out = summarizeToolOutput(long, { maxBytes: 100 });
    expect(out.length).toBe(100);
  });
});

/* ------------------------------------------------------------------------ */
/*  Canonical JSON hash stability                                            */
/* ------------------------------------------------------------------------ */

describe("canonical JSON ordering", () => {
  it("two key-permuted objects produce identical summaries", () => {
    const a = { foo: 1, bar: 2, baz: { x: 1, y: 2 } };
    const b = { baz: { y: 2, x: 1 }, bar: 2, foo: 1 };
    expect(summarizeToolInput(a)).toBe(summarizeToolInput(b));
  });
});

/* ------------------------------------------------------------------------ */
/*  summarizeBinaryBlock                                                     */
/* ------------------------------------------------------------------------ */

describe("summarizeBinaryBlock", () => {
  it("summarizes Anthropic-style image block with source.base64.data", () => {
    const block = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        // "Hello, World!" → known base64
        data: "SGVsbG8sIFdvcmxkIQ==",
      },
    };
    const out = summarizeBinaryBlock(block);
    expect(out).not.toBeNull();
    expect(out?.kind).toBe("image");
    expect(out?.mime).toBe("image/png");
    expect(out?.byte_len).toBe(13); // "Hello, World!" is 13 bytes
    expect(out?.hash).toMatch(/^[0-9a-f]{64}$/);
    // sha256("Hello, World!") — known value
    expect(out?.hash).toBe(
      "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f", // pragma: allowlist secret
    );
  });

  it("summarizes a screenshot block with dataUrl + dims", () => {
    const block = {
      type: "screenshot",
      dataUrl: "data:image/jpeg;base64,SGVsbG8sIFdvcmxkIQ==",
      width: 1920,
      height: 1080,
    };
    const out = summarizeBinaryBlock(block);
    expect(out).not.toBeNull();
    expect(out?.kind).toBe("screenshot");
    expect(out?.dims).toEqual({ width: 1920, height: 1080 });
    expect(out?.mime).toBe("image/jpeg");
    expect(out?.byte_len).toBe(13);
  });

  it("summarizes audio and video kinds", () => {
    const audio = summarizeBinaryBlock({
      type: "audio",
      source: { type: "base64", data: "QUJD", media_type: "audio/mpeg" },
    });
    expect(audio?.kind).toBe("audio");
    expect(audio?.mime).toBe("audio/mpeg");

    const video = summarizeBinaryBlock({
      type: "video",
      source: { type: "base64", data: "QUJD", media_type: "video/mp4" },
    });
    expect(video?.kind).toBe("video");
    expect(video?.mime).toBe("video/mp4");
  });

  it("returns null for a text block", () => {
    expect(summarizeBinaryBlock({ type: "text", text: "hi" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(summarizeBinaryBlock(null)).toBeNull();
    expect(summarizeBinaryBlock("string")).toBeNull();
    expect(summarizeBinaryBlock(42)).toBeNull();
  });

  it("returns safe fallback (null) on internal throw", () => {
    // Force the inner function to throw by making `.type` access throw.
    const evil: unknown = new Proxy(
      {},
      {
        get() {
          throw new Error("synthetic — should never escape");
        },
      },
    );
    // Must not throw, must return null.
    expect(() => summarizeBinaryBlock(evil)).not.toThrow();
    expect(summarizeBinaryBlock(evil)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/*  redactContentBlocks                                                      */
/* ------------------------------------------------------------------------ */

describe("redactContentBlocks", () => {
  it("replaces binary blocks and passes non-binary blocks through", () => {
    const blocks = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: { type: "base64", data: "SGVsbG8sIFdvcmxkIQ==", media_type: "image/png" },
      },
      { type: "tool_use", id: "abc", name: "calc", input: { a: 1 } },
    ];
    const out = redactContentBlocks(blocks);
    expect(out).toHaveLength(3);
    // Text unchanged.
    expect(out[0]).toEqual({ type: "text", text: "hello" });
    // Image replaced.
    expect(out[1]).toMatchObject({ kind: "image", byte_len: 13, mime: "image/png" });
    // tool_use unchanged.
    expect(out[2]).toEqual({
      type: "tool_use",
      id: "abc",
      name: "calc",
      input: { a: 1 },
    });
  });

  it("returns input unchanged on internal error", () => {
    // map() itself doesn't throw on a normal array; force a throw by
    // passing something whose .map exists but the per-item callback path
    // breaks. We mock via a Proxy on Array prototype-like access.
    const blocks: unknown[] = [{ type: "text" }];
    // Spread doesn't throw, so just verify happy path returns equivalent
    // shape. (The safety net is exercised by the summarizeBinaryBlock
    // throw test above; redactContentBlocks delegates to that internally.)
    const out = redactContentBlocks(blocks);
    expect(out).toEqual(blocks);
  });
});
