/**
 * `morse.quotaState()` — public API surface for TQE-04 / MHQ-749.
 *
 * Mirrors Python's `TestModuleLevelQuotaState` in
 * `apps/sdk/python/tests/test_transport_retry.py`: uninitialized SDK
 * returns null, an initialized SDK exposes the transport's parsed 429
 * state.
 *
 * Uses the real `BatchTransport` (via `_setTransportFactoryForTesting`
 * returning an actual instance) with a mocked `fetchImpl`, since
 * `quotaState()` reads through to `_internal/transport.ts`'s
 * module-level state — a stub transport (as `installMockTransport()`
 * elsewhere in this test suite uses) would never populate it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as morse from "../src/index";
import { BatchTransport } from "../src/_internal/transport";

const ENV_KEYS = ["MORSE_API_KEY", "MORSE_ENDPOINT", "MORSE_DISABLED"];

beforeEach(() => {
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  morse._resetForTesting();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("morse.quotaState()", () => {
  it("returns null when the SDK is uninitialized", () => {
    expect(morse.quotaState()).toBeNull();
  });

  it("returns null when initialized but no 429 has been observed", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    morse._setTransportFactoryForTesting((opts) => new BatchTransport({ ...opts, fetchImpl }));
    morse.init({ apiKey: "av_test", endpoint: "https://example.test/api" }); // pragma: allowlist secret

    expect(morse.quotaState()).toBeNull();
  });

  it("exposes the transport's parsed event-limit state after a 429", async () => {
    const eventLimitBody = {
      error: "event_limit_exceeded",
      current_count: 5000,
      limit_count: 5000,
      plan_id: "free",
      period_start: "2026-07-01T00:00:00+00:00",
      upgrade_url: "https://app.morsehq.dev/billing",
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(eventLimitBody), {
        status: 429,
      })) as unknown as typeof fetch;
    morse._setTransportFactoryForTesting(
      (opts) => new BatchTransport({ ...opts, flushIntervalSeconds: 100, fetchImpl }),
    );
    morse.init({ apiKey: "av_test", endpoint: "https://example.test/api" }); // pragma: allowlist secret

    morse.track({ agentId: "agent-x", runData: { success: true } });
    await morse.flush();

    const state = morse.quotaState();
    expect(state).not.toBeNull();
    expect(state?.kind).toBe("event_limit");
    expect(state?.planId).toBe("free");
  });

  it("returns null again after _resetForTesting() (no leakage across tests)", () => {
    // Regression guard for the reset hook this change adds — a prior test
    // in the same file (or run order) observing a 429 must not leak into
    // a later test that never touches the transport.
    expect(morse.quotaState()).toBeNull();
  });
});
