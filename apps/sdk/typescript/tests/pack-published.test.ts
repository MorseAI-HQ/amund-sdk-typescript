/**
 * `pnpm pack:published` (MHQ-1411): the helper must pack under the PUBLISHED
 * npm name (`@morsehq-dev/sdk`, as the release workflow rewrites it) without
 * touching the repo's package.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs helper without type declarations
import { packPublished, publishedPackageName } from "../scripts/pack-published.mjs";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pack-published-test-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("pack:published", () => {
  it("reads the published name from the release workflow", () => {
    expect(publishedPackageName()).toBe("@morsehq-dev/sdk");
  });

  it("packs under the published name and leaves the source package.json untouched", () => {
    const sdk = join(work, "sdk");
    mkdirSync(join(sdk, "dist"), { recursive: true });
    const original =
      JSON.stringify(
        { name: "@morsehq/sdk", version: "9.9.9", files: ["dist"], main: "./dist/index.js" },
        null,
        2,
      ) + "\n";
    writeFileSync(join(sdk, "package.json"), original);
    writeFileSync(join(sdk, "dist", "index.js"), "export {};\n");

    const outDir = join(work, "out");
    const tarball = packPublished({ sdkDir: sdk, outDir, build: false });

    expect(tarball.startsWith(outDir)).toBe(true);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
    expect(manifest.name).toBe("@morsehq-dev/sdk");
    expect(manifest.version).toBe("9.9.9");
    expect(readFileSync(join(sdk, "package.json"), "utf8")).toBe(original);
  }, 60_000); // shells out to `npm pack`, slow on a loaded CI runner
});
