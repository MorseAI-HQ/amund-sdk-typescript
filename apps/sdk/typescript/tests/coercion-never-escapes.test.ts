/**
 * MHQ-947: a user value that throws during coercion must not reach host code.
 *
 * The non-invasive guarantee says telemetry never breaks the application.
 * Cost dimensions and span metadata are USER values, and the SDK is the one
 * that chooses to read and stringify them — so an unguarded `String(v)` or
 * property read runs arbitrary customer code (`toString`, `valueOf`, a getter)
 * on the telemetry path.
 *
 * Three sites had it unguarded, all three confirmed reproducible on
 * 0.5.0-rc.5 by crashing a real process:
 *
 *   setContext({...})              threw INTO host code
 *   run({ userMetadata })          threw at trace START, taking the callback
 *   spanAsync({ metadata })        threw through redactValue -> buildTraceDict
 *                                  -> endTrace and terminated the process
 *
 * The trigger is not exotic: an ORM object whose `toString` lazily hits a dead
 * connection gets there without anyone being clever.
 *
 * These pin the SHAPE of the fix, not just the absence of a throw. The guard
 * is per key/field, so one bad value costs that value and everything else
 * still arrives — wrapping the whole call would have been easier and would
 * have silently discarded the customer's good dimensions too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import * as diagnostics from "../src/_internal/diagnostics";
import { coerceDims } from "../src/_internal/tracing";

/** Throws from every path `String()` might take. */
const detonator = {
  toString(): string {
    throw new Error("coercion probe: toString");
  },
  valueOf(): number {
    throw new Error("coercion probe: valueOf");
  },
};

function detonatingGetter(): Record<string, unknown> {
  const o = {};
  Object.defineProperty(o, "boom", {
    enumerable: true,
    get() {
      throw new Error("coercion probe: getter");
    },
  });
  return o;
}

beforeEach(() => {
  morse._resetForTesting();
  diagnostics._resetForTesting();
  process.env.MORSE_API_KEY = "mhq_test"; // pragma: allowlist secret
  process.env.MORSE_ENDPOINT = "https://api.example.test";
});

afterEach(() => {
  morse._resetForTesting();
  diagnostics._resetForTesting();
  delete process.env.MORSE_API_KEY;
  delete process.env.MORSE_ENDPOINT;
});

describe("MHQ-947: coercion failures stay inside the SDK", () => {
  it("drops only the offending key", () => {
    expect(coerceDims({ customerId: "c-42", feature: detonator, team: "core" }, "t")).toEqual({
      customerId: "c-42",
      team: "core",
    });
  });

  it("never throws even when every value is bad", () => {
    expect(() => coerceDims({ a: detonator, b: detonator }, "t")).not.toThrow();
    expect(coerceDims({ a: detonator, b: detonator }, "t")).toEqual({});
  });

  it("reports each failure", () => {
    const spy = vi.spyOn(diagnostics, "report").mockImplementation(() => {});

    coerceDims({ bad: detonator, worse: detonator }, "test.fingerprint");

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("setContext does not throw into host code", async () => {
    morse.init({ apiKey: "mhq_test", endpoint: "https://api.example.test" }); // pragma: allowlist secret

    await expect(
      morse.runTraced({ agentName: "coercion-probe" }, async () => {
        // Before MHQ-947 this threw straight through.
        morse.setContext({ customerId: "c-42", feature: detonator, team: "core" });
        return "done";
      }),
    ).resolves.toBe("done");
  });

  it("run({ userMetadata }) does not break trace start", async () => {
    morse.init({ apiKey: "mhq_test", endpoint: "https://api.example.test" }); // pragma: allowlist secret

    let bodyRan = false;
    // Before MHQ-947 the callback never ran: coercion happened at trace start.
    await morse.runTraced(
      { agentName: "coercion-probe", userMetadata: { customerId: "c-7", bad: detonator } },
      async () => {
        bodyRan = true;
      },
    );

    expect(bodyRan).toBe(true);
  });

  it("a throwing getter in span metadata does not kill the trace", async () => {
    morse.init({ apiKey: "mhq_test", endpoint: "https://api.example.test" }); // pragma: allowlist secret

    // This is the one that terminated a real Node process on rc.4/rc.5:
    // redactValue -> buildTraceDict -> endTrace -> runAsync, unguarded.
    await expect(
      morse.runTraced({ agentName: "coercion-probe" }, async () => {
        await morse.spanAsync(
          { name: "s", type: "custom", metadata: { bad: detonatingGetter() } },
          async () => "inner",
        );
        return "done";
      }),
    ).resolves.toBe("done");
  });
});
