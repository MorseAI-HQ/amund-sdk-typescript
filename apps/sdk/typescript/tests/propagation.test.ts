/**
 * W3C Trace Context propagation tests.
 *
 * Covers:
 *   - Round-trip: format → parse returns the same trace_id / span_id pair.
 *   - extractTraceparent rejects malformed headers (wrong version, wrong
 *     length, all-zero IDs, non-hex chars).
 *   - injectTraceparent is a no-op when no trace is active.
 *   - injectIntoRequestInit produces a fresh Headers object.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractTraceparent,
  formatTraceparent,
  injectIntoRequestInit,
  injectTraceparent,
  W3C_TRACEPARENT_HEADER,
} from "../src/propagation";
import * as morse from "../src/index";

beforeEach(() => {
  morse._resetForTesting();
  delete process.env.MORSE_API_KEY;
});

afterEach(() => {
  morse._resetForTesting();
});

describe("formatTraceparent / extractTraceparent round-trip", () => {
  it("preserves trace_id and span_id", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const value = formatTraceparent(traceId, spanId);
    expect(value).toBe(`00-${traceId}-${spanId}-01`);

    const parsed = extractTraceparent({ [W3C_TRACEPARENT_HEADER]: value });
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(traceId);
    expect(parsed!.parentSpanId).toBe(spanId);
  });

  it("works with a Headers object", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const headers = new Headers();
    headers.set(W3C_TRACEPARENT_HEADER, formatTraceparent(traceId, spanId));
    const parsed = extractTraceparent(headers);
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(traceId);
    expect(parsed!.parentSpanId).toBe(spanId);
  });
});

describe("extractTraceparent — invalid inputs", () => {
  it.each([
    "00-tooShort-00f067aa0ba902b7-01",
    "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // wrong version
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902-01", // span too short
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01", // all-zero trace
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01", // all-zero span
    "00-4bf92f3577b34da6a3ce929d0e0e473G-00f067aa0ba902b7-01", // non-hex
    "garbage",
    "",
  ])("rejects %s", (input) => {
    expect(extractTraceparent({ [W3C_TRACEPARENT_HEADER]: input })).toBeNull();
  });

  it("returns null when the header is missing", () => {
    expect(extractTraceparent({})).toBeNull();
    expect(extractTraceparent(null)).toBeNull();
    expect(extractTraceparent(undefined)).toBeNull();
  });
});

describe("injectTraceparent", () => {
  it("is a no-op when no trace is active", () => {
    const headers: Record<string, string> = {};
    injectTraceparent(headers);
    expect(headers[W3C_TRACEPARENT_HEADER]).toBeUndefined();
  });

  it("adds traceparent inside an active trace", async () => {
    process.env.MORSE_API_KEY = "av_x";
    let captured: string | null = null;

    await morse.runTraced({ agentName: "test" }, async () => {
      const headers: Record<string, string> = {};
      injectTraceparent(headers);
      captured = headers[W3C_TRACEPARENT_HEADER] ?? null;
    });

    expect(captured).not.toBeNull();
    const parsed = extractTraceparent({ [W3C_TRACEPARENT_HEADER]: captured! });
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed!.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("injectIntoRequestInit produces a fresh Headers", async () => {
    process.env.MORSE_API_KEY = "av_x";

    await morse.runTraced({ agentName: "test" }, async () => {
      const init = injectIntoRequestInit({ headers: { "X-Custom": "v" } });
      const headers = init.headers as Headers;
      expect(headers.get("X-Custom")).toBe("v");
      expect(headers.get(W3C_TRACEPARENT_HEADER)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });
  });
});
