/**
 * MHQ-806: span() outside a run must be a no-op that says so.
 *
 * The no-op itself is correct — library code may be instrumented but reached
 * from an untraced path, and throwing there would be worse than recording
 * nothing. The defect was that it was *silent*. TypeScript surfaces the null
 * handle in the type, unlike Python's context-manager form, but callers
 * routinely ignore it (`span({...}, () => { ... })` never touches the handle),
 * so the observable outcome was identical: no error, no spans, nothing to
 * distinguish it from working instrumentation.
 *
 * startSpan is the single choke point for startSpan / spanSync / spanAsync, so
 * these cover all three entry points.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as morse from "../src/index";
import { _resetSpanOutsideTraceWarning } from "../src/_internal/tracing";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  morse._resetForTesting();
  _resetSpanOutsideTraceWarning();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  morse._resetForTesting();
  _resetSpanOutsideTraceWarning();
});

function warningsAboutNoTrace(): string[] {
  return warnSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((m: string) => m.includes("no active trace"));
}

describe("span() outside a trace", () => {
  it("warns, naming both the span and the fix", () => {
    morse.span({ name: "orphan", type: "llm" }, () => {});

    const warnings = warningsAboutNoTrace();
    expect(warnings).toHaveLength(1);
    // Names the offending span so it can be found...
    expect(warnings[0]).toContain("orphan");
    // ...and names the fix, not just the symptom.
    expect(warnings[0]).toContain("morse.run");
  });

  it("warns at most once per process, not per call", () => {
    for (let i = 0; i < 50; i++) {
      morse.span({ name: `orphan-${i}` }, () => {});
    }
    expect(warningsAboutNoTrace()).toHaveLength(1);
  });

  it("covers the async wrapper through the same choke point", async () => {
    await morse.spanAsync({ name: "orphan-async" }, async () => {});
    expect(warningsAboutNoTrace()).toHaveLength(1);
  });

  it("still returns the callback's value and passes a null handle", () => {
    let received: unknown = "unset";
    const result = morse.span({ name: "orphan" }, (handle) => {
      received = handle;
      return 42;
    });
    // Behaviour must be unchanged by the warning.
    expect(result).toBe(42);
    expect(received).toBeNull();
  });

  it("stays quiet inside a run — the common, correct usage", () => {
    morse.init({ apiKey: "mhq_test", endpoint: "https://example.invalid" }); // pragma: allowlist secret
    morse.run("agent", () => {
      morse.span({ name: "child", type: "llm" }, () => {});
    });
    expect(warningsAboutNoTrace()).toEqual([]);
  });
});
