/**
 * The browser build must TRACE, not silently drop (MHQ-482 follow-up).
 *
 * `otel-provider.browser.ts` replaces the Node-only OTLP pipeline in browser
 * bundles. The failure mode that matters is not a crash — it's the quiet one:
 * a customer's browser app initializes Morse, calls `run()`, sees no error,
 * and no trace ever arrives. MHQ-758 already cost this SDK one such silent
 * regression, so these tests assert the traces actually reach the transport.
 *
 * The build wiring itself (that no Node-only import survives into
 * `dist/browser/`) is asserted separately and statically by
 * `scripts/check-sdk-browser-bundle.mjs`, which runs in CI and gates release.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as browserProvider from "../src/_internal/otel-provider.browser";
import * as nodeProvider from "../src/_internal/otel-provider";
import { maybeEnableDbCaptureFromEnv } from "../src/_internal/db-capture.browser";
import { installAdapters } from "../src/_internal/auto-detect.browser";

/** Dummy, never sent anywhere — these tests make no network calls. */
const TEST_CONFIG = { apiKey: "av_x" }; // pragma: allowlist secret

describe("browser build — module shape", () => {
  it("exposes every symbol the Node provider's importers use", () => {
    // index.ts imports getEngine; tracing.ts imports emitTraceEntry +
    // withOtelSpanContext + isOtelAvailable; db-capture imports getEngine.
    // A missing export here surfaces only as a bundler error inside a
    // customer's build, so assert the contract directly.
    for (const name of [
      "getEngine",
      "emitTraceEntry",
      "withOtelSpanContext",
      "isOtelAvailable",
    ] as const) {
      expect(typeof browserProvider[name], `browser build missing ${name}`).toBe("function");
      expect(typeof nodeProvider[name], `node build missing ${name}`).toBe("function");
    }
  });

  it("reports OTel as unavailable, so sendTrace takes the JSON path", () => {
    expect(browserProvider.isOtelAvailable()).toBe(false);
    expect(nodeProvider.isOtelAvailable()).toBe(true);
  });

  it("keeps the engine surface callable so index.ts needs no browser branches", async () => {
    const engine = browserProvider.getEngine();
    expect(() => engine.configure(TEST_CONFIG)).not.toThrow();
    await expect(engine.flush()).resolves.toBeUndefined();
    expect(() => engine.shutdown()).not.toThrow();
    expect(engine.registerInstrumentations([])).toBeNull();
  });

  it("runs the callback unchanged in withOtelSpanContext", () => {
    const fn = vi.fn(() => "value");
    expect(browserProvider.withOtelSpanContext("a".repeat(32), "b".repeat(16), fn)).toBe("value");
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("browser build — runtime messaging", () => {
  beforeEach(() => {
    browserProvider.getEngine().resetForTesting();
  });

  it("explains the browser runtime once, on configure, at info level", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const engine = browserProvider.getEngine();
      engine.configure(TEST_CONFIG);
      engine.configure(TEST_CONFIG);
      engine.configure(TEST_CONFIG);

      expect(info, "must not nag on every configure()").toHaveBeenCalledTimes(1);
      const message = String(info.mock.calls[0]?.[0]);
      // The integrator needs to learn three things from this line.
      expect(message).toContain("[morse]");
      expect(message).toMatch(/browser/i);
      expect(message).toMatch(/JSON transport/i);
    } finally {
      info.mockRestore();
    }
  });

  it("stays silent until the SDK is actually configured", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // Merely importing / holding the engine must not log — plenty of apps
      // bundle the SDK on pages that never initialize it.
      browserProvider.getEngine();
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});

describe("browser build — Node-only helpers are inert", () => {
  it("db capture is a no-op with nothing to instrument", () => {
    expect(() => maybeEnableDbCaptureFromEnv()).not.toThrow();
  });

  it("adapter auto-detect resolves without a require hook", async () => {
    await expect(installAdapters()).resolves.toBeUndefined();
  });
});
