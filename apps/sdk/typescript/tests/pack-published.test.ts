/**
 * `pnpm pack:published`: since the Amund rebrand a release packs and publishes TWO
 * packages under their in-repo names, with no rename step:
 *   - `@amundai/sdk` (this package)
 *   - `@morsehq-dev/sdk` (compat/morsehq-dev-sdk, a re-export shim)
 * The shim's runtime behaviour is covered by compat/morsehq-dev-sdk/test and
 * scripts/smoke-packed.mjs (both need a build); this file keeps the cheap
 * static guarantees in the main suite.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  packDir,
  publishedPackageName,
  SDK_DIR,
  SHIM_DIR,
  tarballName,
  // @ts-expect-error plain .mjs helper without type declarations
} from "../scripts/pack-published.mjs";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pack-published-test-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("pack:published", () => {
  it("publishes the SDK as @amundai/sdk and the shim as @morsehq-dev/sdk", () => {
    expect(publishedPackageName()).toBe("@amundai/sdk");
    expect(publishedPackageName(SHIM_DIR)).toBe("@morsehq-dev/sdk");
    expect(tarballName("@amundai/sdk", "0.8.0")).toBe("amundai-sdk-0.8.0.tgz");
  });

  it("the release workflow no longer rewrites the package name", () => {
    const wf = readFileSync(
      join(SDK_DIR, "../../../.github/workflows/release-typescript.yml"),
      "utf8",
    );
    expect(wf).not.toMatch(/pkg\.name\s*=/);
    expect(wf).not.toMatch(/PUBLISHED_PACKAGE_NAME/);
  });

  it("packs a package directory as-is", () => {
    const pkgDir = join(work, "pkg");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    const original =
      JSON.stringify(
        { name: "@amund/fake", version: "9.9.9", files: ["dist"], main: "./dist/index.js" },
        null,
        2,
      ) + "\n";
    writeFileSync(join(pkgDir, "package.json"), original);
    writeFileSync(join(pkgDir, "dist", "index.js"), "export {};\n");

    const outDir = join(work, "out");
    const tarball = packDir({ dir: pkgDir, outDir });

    expect(tarball).toBe(join(outDir, "amund-fake-9.9.9.tgz"));
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
    expect(manifest.name).toBe("@amund/fake");
    expect(manifest.version).toBe("9.9.9");
    expect(readFileSync(join(pkgDir, "package.json"), "utf8")).toBe(original);
  }, 60_000); // shells out to `pnpm pack`, slow on a loaded CI runner
});

describe("@morsehq-dev/sdk shim stays in lockstep with @amundai/sdk", () => {
  const sdk = readJson(join(SDK_DIR, "package.json"));
  const shim = readJson(join(SHIM_DIR, "package.json"));

  it("mirrors the exports map exactly (every subpath, every condition)", () => {
    expect(shim.exports).toEqual(sdk.exports);
    expect(JSON.stringify(shim.exports)).toBe(JSON.stringify(sdk.exports)); // key order too
    for (const k of ["main", "module", "types", "type"]) expect(shim[k]).toBe(sdk[k]);
  });

  it("has the same version and depends on exactly that @amundai/sdk", () => {
    expect(shim.version).toBe(sdk.version);
    // `pnpm pack` turns workspace:* into the exact version (checked on the
    // real tarball by scripts/smoke-packed.mjs).
    expect(shim.dependencies).toEqual({ "@amundai/sdk": "workspace:*" });
  });

  it("is publishable and ships only dist/", () => {
    expect(shim.private).toBe(false);
    expect(shim.files).toEqual(["dist"]);
  });
});
