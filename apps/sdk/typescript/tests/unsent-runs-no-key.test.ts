/**
 * MHQ-1787 — a run opened with no API key says so, loudly, once, at exit.
 *
 * With no `MORSE_API_KEY` and no `init()`, `morse.run()` keeps handing back a
 * real-looking trace id (unchanged on purpose) while nothing is sent. The
 * first-use "SDK calls are silent no-ops" warning is easy to miss, so a single
 * warning at process exit names how many runs were not sent. No new public
 * attribute exists; the count is internal to diagnostics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import {
  warnUnsentRunsAtExit,
  _resetForTesting as resetDiagnostics,
} from "../src/_internal/diagnostics";

const WARNING = "run(s) not sent: no API key (set MORSE_API_KEY or call init())";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  morse._resetForTesting();
  resetDiagnostics();
  for (const k of ["MORSE_API_KEY", "MORSE_ENDPOINT", "MORSE_DISABLED"]) delete process.env[k];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  resetDiagnostics();
});

const exitWarnings = (): string[] =>
  warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes(WARNING));

describe("MHQ-1787 — unsent runs warn once at exit", () => {
  it("counts runs opened with no key, keeps the trace id, warns once", async () => {
    const ids: string[] = [];
    morse.run("x", (h) => {
      ids.push(h._state.traceId);
    });
    await morse.runTraced({ agentName: "y" }, async (h) => {
      ids.push(h._state.traceId);
    });
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => id.length === 32)).toBe(true);

    expect(exitWarnings()).toHaveLength(0); // nothing until exit
    warnUnsentRunsAtExit();
    warnUnsentRunsAtExit(); // one-time: a second exit call says nothing more
    expect(exitWarnings()).toEqual([`morse: 2 ${WARNING}`]);
  });

  it("does not warn when MORSE_DISABLED is a deliberate opt-out", () => {
    process.env.MORSE_DISABLED = "1";
    morse.run("x", () => {});
    warnUnsentRunsAtExit();
    expect(exitWarnings()).toHaveLength(0);
  });

  it("does not warn when a key is set", () => {
    process.env.MORSE_API_KEY = "av_test"; // pragma: allowlist secret
    process.env.MORSE_ENDPOINT = "http://localhost:0";
    morse.run("x", () => {});
    warnUnsentRunsAtExit();
    expect(exitWarnings()).toHaveLength(0);
  });
});
