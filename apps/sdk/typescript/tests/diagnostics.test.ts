/**
 * SDK self-diagnostics (MHQ-908, SDKDIAG-01..10).
 *
 * Mirrors `apps/sdk/python/tests/test_diagnostics.py`. The invariants worth
 * protecting are mostly *negative* — what the SDK does NOT do: no timer on a
 * healthy install, no host frames on the wire, no retry, no self-report, no
 * silence for an opted-out customer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as diagnostics from "../src/_internal/diagnostics";
import { absorbErrorsSync } from "../src/_internal/errors";
import { BatchTransport } from "../src/_internal/transport";

const ENV_KEYS = [
  "MORSE_API_KEY",
  "MORSE_ENDPOINT",
  "MORSE_SDK_DISABLE_TELEMETRY",
  "MORSE_DISABLED",
  "MORSE_SDK_DEBUG",
];

beforeEach(() => {
  diagnostics._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

afterEach(() => {
  diagnostics._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

function sdkishError(): Error {
  const err = new Error("span_id missing");
  err.stack = [
    "Error: span_id missing",
    "    at finishTrace (/app/node_modules/@morsehq/sdk/dist/tracing.js:336:11)",
    "    at handler (/srv/customer-app/src/routes/checkout.ts:42:7)",
    "    at Server.run (/srv/customer-app/src/server.ts:11:3)",
  ].join("\n");
  return err;
}

// --- SDKDIAG-01 — emitted only on an absorbed error -------------------------

describe("SDKDIAG-01: emission", () => {
  it("arms no flush timer on a healthy install", () => {
    // Option B's cost argument, made concrete: an armed setInterval keeps the
    // Node event loop alive, so a healthy process must never arm one.
    expect(diagnostics._hasTimer()).toBe(false);
  });

  it("does not transmit without an API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    diagnostics.report(sdkishError(), { fingerprint: "test.no_key" });

    await diagnostics.flushOnce();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("transmits nothing when there is nothing to report", async () => {
    process.env.MORSE_API_KEY = "test-key"; // pragma: allowlist secret
    process.env.MORSE_ENDPOINT = "https://api.example.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await diagnostics.flushOnce();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets the customer kill switch beat a server-pushed debug level", () => {
    process.env.MORSE_SDK_DISABLE_TELEMETRY = "1";
    diagnostics.setLevel("debug");

    expect(diagnostics.transmissionAllowed()).toBe(false);
  });
});

// --- SDKDIAG-02 — Morse-scoped payload --------------------------------------

describe("SDKDIAG-02: payload scoping", () => {
  it("keeps SDK frames and elides host frames into a count", () => {
    const stack = diagnostics.buildScopedStack(sdkishError());

    expect(stack[0]).toMatchObject({ function: "finishTrace", line: 336 });
    expect(stack[1]).toEqual({ elided: 2 });
  });

  it("never emits a frame carrying locals", () => {
    const stack = diagnostics.buildScopedStack(sdkishError());

    for (const frame of stack) {
      expect(frame).not.toHaveProperty("vars");
      expect(frame).not.toHaveProperty("locals");
    }
  });

  it("does not ship the host's absolute paths", () => {
    const stack = diagnostics.buildScopedStack(sdkishError());
    const files = stack.map((f) => f.file).filter(Boolean) as string[];

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.startsWith("/")).toBe(false);
    }
  });

  it("fails closed on an unrecognised frame", () => {
    // A bundled build flattens paths; an unmatched frame must be treated as the
    // host's. Over-eliding costs a debugging detail, under-eliding ships the
    // customer's layout.
    const err = new Error("boom");
    err.stack = ["Error: boom", "    at mystery (/opt/unknown/thing.js:1:1)"].join("\n");

    expect(diagnostics.buildScopedStack(err)).toEqual([{ elided: 1 }]);
  });

  it("recognises frames from the PUBLISHED package name, not just the in-repo one", () => {
    // The in-repo package.json name is `@morsehq/sdk`, but release-typescript.yml
    // rewrites it to `@morsehq-dev/sdk` before publish — so every customer stack
    // looks like this and NEVER contains the in-repo name.
    //
    // Through 0.5.0-rc.4 only the in-repo name was listed, so published builds
    // elided all of their own frames and diagnostics could not locate a failure.
    // These are real frames captured from a published-rc4 install on 2026-08-07.
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at redactValue (/app/node_modules/@morsehq-dev/sdk/dist/chunk-ELBY4SJ7.js:249:35)",
      "    at endTrace (/app/node_modules/@morsehq-dev/sdk/dist/chunk-ELBY4SJ7.js:1382:16)",
      "    at handler (/srv/app/routes/checkout.js:12:3)",
    ].join("\n");

    const stack = diagnostics.buildScopedStack(err);

    expect(stack[0]).toMatchObject({ function: "redactValue", line: 249 });
    expect(stack[1]).toMatchObject({ function: "endTrace", line: 1382 });
    // The host's frame is still elided — the fix must not open the fail-closed door.
    expect(stack[2]).toEqual({ elided: 1 });
  });

  it("still elides a host path that merely contains our name", () => {
    // Guards the fail-closed property against a broader `morsehq` substring
    // match: a customer whose code lives under a morsehq-named directory must
    // not have their frames transmitted in full.
    const err = new Error("boom");
    err.stack = ["Error: boom", "    at pay (/home/morsehq/app/src/billing.js:9:1)"].join("\n");

    expect(diagnostics.buildScopedStack(err)).toEqual([{ elided: 1 }]);
  });

  it("caps the stack", () => {
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      ...Array.from(
        { length: 500 },
        (_, i) => `    at f${i} (/app/node_modules/@morsehq/sdk/dist/x.js:${i}:1)`,
      ),
    ].join("\n");

    expect(diagnostics.buildScopedStack(err).length).toBeLessThanOrEqual(
      diagnostics.MAX_STACK_ENTRIES,
    );
  });

  it("allow-lists extras", () => {
    expect(
      diagnostics.scrubExtra({
        adapter: "anthropic",
        prompt: "customer text",
        operation: "wrap",
      }),
    ).toEqual({ adapter: "anthropic", operation: "wrap" });
  });
});

// --- SDKDIAG-05 — server-controlled verbosity -------------------------------

describe("SDKDIAG-05: verbosity", () => {
  it("defaults to error before any header is seen", () => {
    expect(diagnostics.getLevel()).toBe(diagnostics.LEVEL_ERROR);
  });

  it("learns the level from the header", () => {
    diagnostics.setLevel("debug");
    expect(diagnostics.getLevel()).toBe(diagnostics.LEVEL_DEBUG);

    diagnostics.setLevel("off");
    expect(diagnostics.transmissionAllowed()).toBe(false);
  });

  it("ignores an unknown level rather than muting", () => {
    diagnostics.setLevel("verbose-plus");

    expect(diagnostics.getLevel()).toBe(diagnostics.LEVEL_ERROR);
  });

  it("derives the diagnostics URL from the ingest endpoint", () => {
    expect(diagnostics.deriveDiagnosticsUrl("https://api.example.com/api/v1/traces/batch")).toBe(
      "https://api.example.com/api/v1/diagnostics/sdk",
    );
    expect(diagnostics.deriveDiagnosticsUrl("not a url")).toBeNull();
  });
});

// --- SDKDIAG-06 — cannot break or amplify itself ----------------------------

describe("SDKDIAG-06: self-containment", () => {
  it("never throws even when the stack builder explodes", () => {
    const err = {
      get stack(): string {
        throw new Error("exploding getter");
      },
    };

    expect(() => diagnostics.report(err, { fingerprint: "test.explode" })).not.toThrow();
  });

  it("does not retry a failed send", async () => {
    process.env.MORSE_API_KEY = "test-key"; // pragma: allowlist secret
    process.env.MORSE_ENDPOINT = "https://api.example.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    diagnostics.report(sdkishError(), { fingerprint: "test.no_retry" });
    await diagnostics.flushOnce();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("opens the breaker after repeated failures and stops sending", async () => {
    process.env.MORSE_API_KEY = "test-key"; // pragma: allowlist secret
    process.env.MORSE_ENDPOINT = "https://api.example.com";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    for (let i = 0; i < 5; i += 1) {
      diagnostics.report(sdkishError(), { fingerprint: `test.breaker${i}` });
      await diagnostics.flushOnce();
    }

    // 3 failures open the breaker; everything after is suppressed.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

// --- SDKDIAG-09 — delivery counters -----------------------------------------

describe("SDKDIAG-09: delivery counters", () => {
  it("aggregates many drops into one entry", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 10_000; i += 1) {
      diagnostics.recordDrop(diagnostics.REASON_QUEUE_FULL, "span");
    }

    const drained = diagnostics.drainCounters();

    expect(drained).toEqual([
      { reason: diagnostics.REASON_QUEUE_FULL, category: "span", quantity: 10_000 },
    ]);
  });

  it("drains destructively and reports nothing when idle", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    diagnostics.recordDrop(diagnostics.REASON_RETRY_EXHAUSTED, "trace", 3);

    expect(diagnostics.drainCounters()).toHaveLength(1);
    expect(diagnostics.drainCounters()).toEqual([]);
  });

  it("counts a full transport queue", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new BatchTransport({
      endpoint: "https://api.example.com/api/v1/traces/batch",
      apiKey: "k",
      maxQueueSize: 1,
      fetchImpl: vi.fn(),
    });

    expect(transport.track({ traces: [] })).toBe(true);
    expect(transport.track({ traces: [] })).toBe(false);

    const drained = diagnostics.drainCounters();
    expect(drained.some((d) => d.reason === diagnostics.REASON_QUEUE_FULL)).toBe(true);
  });
});

// --- SDKDIAG-10 — no private channel ----------------------------------------

describe("SDKDIAG-10: local visibility", () => {
  it("still logs locally when the customer opted out of transmission", () => {
    process.env.MORSE_SDK_DISABLE_TELEMETRY = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    diagnostics.report(sdkishError(), { fingerprint: "test.optout" });

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("test.optout");
  });

  it("still logs locally when the server level is off", () => {
    diagnostics.setLevel("off");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    diagnostics.report(sdkishError(), { fingerprint: "test.leveloff" });

    expect(warn).toHaveBeenCalledOnce();
  });

  it("surfaces delivery loss at warn level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    diagnostics.recordDrop(diagnostics.REASON_QUEUE_FULL, "span", 5);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("queue_full");
  });

  it("rate-limits local logging so a loop cannot flood the host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 500; i += 1) {
      diagnostics.report(sdkishError(), { fingerprint: "test.flood" });
    }

    expect(warn).toHaveBeenCalledTimes(diagnostics.LOCAL_LOG_LIMIT_PER_WINDOW);
  });
});

// --- SDKDIAG-07 — absorb path ------------------------------------------------

describe("SDKDIAG-07: absorb path", () => {
  it("absorbErrors reports and returns undefined", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapped = absorbErrorsSync(
      () => {
        throw new Error("nope");
      },
      { fingerprint: "morse.test.absorb" },
    );

    expect(wrapped()).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain("morse.test.absorb");
  });
});

/**
 * MHQ-973 — `secret_assignment` runs on transmitted diagnostic messages
 * regardless of the org's redaction config.
 *
 * The pattern is disableable, because an org may legitimately want raw
 * `password=` values in *their own* spans. This channel is different: the
 * published disclosure (SDKDIAG-02) promises Morse receives no customer data,
 * and that promise must not be defeatable by a telemetry preference.
 *
 * NB: these assert on the WIRE payload, not the local log. SDKDIAG-10
 * deliberately gives the host the full unredacted message on its own logger —
 * "everything we receive, you also see" — so asserting on console output would
 * be testing the opposite guarantee.
 */
describe("transmitted diagnostic messages are always secret-scrubbed (MHQ-973)", () => {
  async function wireMessages(err: Error, cfg: unknown): Promise<string[]> {
    const sent: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
      try {
        for (const ev of JSON.parse(String(init.body)).events ?? []) {
          if (typeof ev.message === "string") sent.push(ev.message);
        }
      } catch {
        /* ignore */
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    diagnostics.setDiagnosticsClientConfig({
      apiKey: "av_test", // pragma: allowlist secret — fixture, never authenticates
      endpoint: "https://example.test/api/v1/traces/batch",
    });
    diagnostics.setRedactionConfig(cfg as never);
    try {
      diagnostics.report(err, { fingerprint: `mhq973-${Date.now()}-${Math.random()}` });
      await diagnostics.flushOnce();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      globalThis.fetch = origFetch;
      diagnostics.setRedactionConfig(null);
      diagnostics.setDiagnosticsClientConfig(null);
    }
    return sent;
  }

  it("redacts password= with no redaction config set", async () => {
    const sent = await wireMessages(new Error("boom password=hunter2 tail"), null);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join(" ")).not.toContain("hunter2");
    expect(sent.join(" ")).toContain("[REDACTED:secret]");
  });

  it("still redacts when the org disabled the pattern", async () => {
    const sent = await wireMessages(new Error("db password=hunter2"), {
      enabled: true,
      enabledPatterns: new Set(["api_key_prefixed", "jwt"]),
      extraPatterns: [],
    });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join(" ")).not.toContain("hunter2");
  });

  it("leaves LLM token counts alone", async () => {
    const sent = await wireMessages(new Error("usage input_tokens=100 max_tokens=4096"), null);
    expect(sent.join(" ")).toContain("input_tokens=100");
    expect(sent.join(" ")).toContain("max_tokens=4096");
  });
});
