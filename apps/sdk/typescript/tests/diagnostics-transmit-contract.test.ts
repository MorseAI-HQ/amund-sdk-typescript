/**
 * MHQ-1054: what actually has to be true for `sdk_diagnostic_events` to fill.
 *
 * `sdk_diagnostic_events` was empty on prod after 0.5.0-rc.1 runs that
 * demonstrably hit internal SDK errors, and the ticket left two explanations
 * open: either transmission is gated on the `X-Morse-Diagnostics` response
 * header handshake (so the SDK was correct to stay quiet), or the path was
 * broken.
 *
 * It is the second. There is no handshake gate — `level` starts at `error`
 * (diagnostics.ts) and the header only ever *changes* it, so the first
 * absorbed error transmits before any Morse response has been seen. rc.1 was
 * silent because `resolveTarget()` read the environment only, so a
 * programmatically-configured client (`morse.init({apiKey, endpoint})`, the
 * documented form) had no destination; MHQ-927 fixed that and MHQ-946 made
 * `shutdown()` drain the buffer.
 *
 * These pin the contract that produced the rows, in the shape a customer
 * reaches it:
 *
 *   1. a genuine `absorbErrors`-absorbed internal error (not a hand-called
 *      `report()`) transmits after `init()` alone — no env vars, no header;
 *   2. the customer kill switch still beats it.
 *
 * @spec SDKDIAG-01
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { absorbErrorsSync } from "../src/_internal/errors";
import { _resetForTesting as resetDiagnostics } from "../src/_internal/diagnostics";

interface DiagnosticsPost {
  url: string;
  authorization: string;
  events: Array<Record<string, unknown>>;
}

/** Stub `fetch` and decode any POST that went to the diagnostics endpoint. */
function captureDiagnosticsPosts(): DiagnosticsPost[] {
  const posts: DiagnosticsPost[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: unknown) => {
      const target = String(url);
      if (target.includes("/api/v1/diagnostics/sdk")) {
        const req = (init ?? {}) as { headers?: Record<string, string>; body?: string };
        posts.push({
          url: target,
          authorization: req.headers?.Authorization ?? "",
          events:
            (JSON.parse(req.body ?? "{}") as { events?: Array<Record<string, unknown>> }).events ??
            [],
        });
      }
      // No `X-Morse-Diagnostics` header on the way back — deliberately. The
      // SDK must already have transmitted to get here.
      return new Response('{"accepted":1,"dropped":0}', { status: 200 });
    }),
  );
  return posts;
}

/** The production absorb path: an internal helper that throws, wrapped. */
const brokenInternal = absorbErrorsSync(
  (): number => {
    throw new TypeError("simulated internal SDK fault");
  },
  { fingerprint: "morse.test.transmit-contract" },
);

beforeEach(() => {
  morse._resetForTesting();
  resetDiagnostics();
  for (const k of [
    "MORSE_API_KEY",
    "MORSE_ENDPOINT",
    "MORSE_DISABLED",
    "MORSE_SDK_DISABLE_TELEMETRY",
  ]) {
    delete process.env[k];
  }
});

describe("MHQ-1054 — an absorbed internal error reaches the diagnostics endpoint", () => {
  it("transmits after init() alone, with no X-Morse-Diagnostics handshake first", async () => {
    const posts = captureDiagnosticsPosts();

    morse.init({ apiKey: "av_test", endpoint: "https://api.example.test" }); // pragma: allowlist secret
    expect(brokenInternal()).toBeUndefined(); // absorbed, as promised
    await morse.shutdown();

    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    // Derived from the ingest endpoint, not from an env var — this is the
    // MHQ-927 half: rc.1 resolved no target at all from a programmatic init.
    expect(post.url).toBe("https://api.example.test/api/v1/diagnostics/sdk");
    expect(post.authorization).toBe("Bearer av_test");

    const error = post.events.find((e) => e.kind === "error");
    expect(error).toBeDefined();
    expect(error!.fingerprint).toBe("morse.test.transmit-contract");
    expect(error!.error_type).toBe("TypeError");
    expect(error!.sdk_language).toBe("typescript");
    expect(String(error!.message)).toContain("simulated internal SDK fault");
  });

  it("MORSE_SDK_DISABLE_TELEMETRY=1 still beats it", async () => {
    const posts = captureDiagnosticsPosts();
    process.env.MORSE_SDK_DISABLE_TELEMETRY = "1";

    morse.init({ apiKey: "av_test", endpoint: "https://api.example.test" }); // pragma: allowlist secret
    brokenInternal();
    await morse.shutdown();

    expect(posts).toHaveLength(0);
  });
});
