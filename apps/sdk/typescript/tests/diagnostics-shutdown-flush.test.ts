/**
 * MHQ-927: `shutdown()` must drain the diagnostics buffer.
 *
 * Diagnostics keeps its own buffer + 5s timer, deliberately separate from the
 * transport. The timer is `unref()`d so it cannot hold the event loop open —
 * so any process that finishes inside 5s exits with its buffer unsent, and
 * nothing else drains it.
 *
 * That is every short-lived process: a script, a CLI, a serverless
 * invocation, and every driver in the SDK adapter matrix. It is why
 * `sdk_diagnostic_events` stayed empty in prod even after the config-
 * resolution fix landed: the request was never issued before exit.
 *
 * Asserted against a stubbed `fetch` with NO timer wait — if the flush only
 * happens on the interval, this test fails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { report, _resetForTesting as resetDiagnostics } from "../src/_internal/diagnostics";

beforeEach(() => {
  morse._resetForTesting();
  resetDiagnostics();
  for (const k of ["MORSE_API_KEY", "MORSE_ENDPOINT", "MORSE_DISABLED"]) delete process.env[k];
});

describe("MHQ-927 — shutdown() drains diagnostics", () => {
  it("sends a buffered diagnostic on shutdown, without waiting for the timer", async () => {
    const spy = vi.fn(async () => new Response('{"accepted":1,"dropped":0}', { status: 200 }));
    vi.stubGlobal("fetch", spy);

    morse.init({ apiKey: "av_test", endpoint: "https://api.example.test" }); // pragma: allowlist secret
    try {
      throw new Error("internal boom");
    } catch (e) {
      report(e, { fingerprint: "shutdown-flush-probe" });
    }

    // No wait: FLUSH_INTERVAL_MS is 5000, so anything sent here came from
    // shutdown() and not from the timer.
    await morse.shutdown();

    expect(spy).toHaveBeenCalled();
    // `vi.fn(async () => ...)` types its call tuple as zero-arg, so index the
    // recorded args through a cast rather than adding unused parameters.
    const calls = spy.mock.calls as unknown as unknown[][];
    expect(String(calls[0]?.[0])).toContain("/api/v1/diagnostics/sdk");
  });

  it("shutdown() is still safe when nothing was reported", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    morse.init({ apiKey: "av_test", endpoint: "https://api.example.test" }); // pragma: allowlist secret
    await expect(morse.shutdown()).resolves.toBeUndefined();
  });
});
