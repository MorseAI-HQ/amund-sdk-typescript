/**
 * Every exported delivery-reason constant must have a real call site.
 *
 * This is the MHQ-972 defect as a standing check. `REASON_ENCODE_FAILED` was
 * exported and used nowhere, so the SDKDIAG-09 counter channel was silent for a
 * whole failure class — and the spec-coverage gate read ✅ because it resolves a
 * requirement to a FILE, not to a call site (MHQ-735).
 *
 * Adding the retry loop in MHQ-1001 nearly orphaned `REASON_SEND_FAILED` the
 * same way; this test is what catches the next one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as diagnostics from "../src/_internal/diagnostics";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

/** The two producers: the legacy JSON transport and the OTLP export tap. */
const CONSUMERS = ["_internal/transport.ts", "_internal/otel-provider.ts"].map((rel) =>
  readFileSync(path.join(SRC, rel), "utf8"),
);

const EXPORTED_REASONS = Object.keys(diagnostics).filter((k) => k.startsWith("REASON_"));

describe("delivery reason codes are reachable (MHQ-972 / MHQ-1001)", () => {
  it("exports at least the reasons the disclosure page documents", () => {
    // Guards against the inverse failure: silently deleting a constant and
    // leaving the published disclosure describing a value we never send.
    expect(EXPORTED_REASONS.length).toBeGreaterThanOrEqual(7);
  });

  it.each(EXPORTED_REASONS)("%s is recorded somewhere", (name) => {
    const used = CONSUMERS.some((src) => {
      // A bare import mention doesn't count — require a use outside the
      // `import { ... }` block, which is what "has a call site" means.
      const withoutImports = src.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]*";/gs, "");
      return withoutImports.includes(name);
    });
    expect(used, `${name} is exported but never recorded — see MHQ-972`).toBe(true);
  });
});
