#!/usr/bin/env node
/**
 * `pnpm pack:published` — pack the SDK exactly as a release ships it.
 *
 * The in-repo package name is `@morsehq/sdk` (pnpm workspace id); the name on
 * npm is `@morsehq-dev/sdk`. `.github/workflows/release-typescript.yml`
 * rewrites `name` on a throwaway runner checkout right before `npm publish`.
 * A tarball packed straight from the repo therefore installs under the wrong
 * name, which is not what a release produces (MHQ-1411, dogfood round 2026-10-18).
 *
 * This script applies the SAME rewrite (`pkg.name = PUBLISHED_PACKAGE_NAME`,
 * re-serialised with `JSON.stringify(pkg, null, 2) + "\n"`), but on a staging
 * copy in the OS temp dir, so the repo's package.json is never modified. The
 * tarball is written outside the source tree.
 *
 * Usage:
 *   pnpm pack:published                 # build, then pack into $TMPDIR/morse-sdk-published
 *   pnpm pack:published --no-build      # reuse an existing dist/
 *   pnpm pack:published --out <dir>     # choose the output directory
 *
 * Prints the absolute tarball path on the last line of stdout.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_PUBLISHED_NAME = "@morsehq-dev/sdk";
const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(HERE, "..");
const WORKFLOW = resolve(SDK_DIR, "../../../.github/workflows/release-typescript.yml");

/** Single source of truth is the release workflow's `PUBLISHED_PACKAGE_NAME`. */
export function publishedPackageName(workflowPath = WORKFLOW) {
  try {
    const text = readFileSync(workflowPath, "utf8");
    const m = text.match(/^\s*PUBLISHED_PACKAGE_NAME:\s*["']?([^"'\s#]+)["']?/m);
    if (m) return m[1];
  } catch {
    // Workflow absent (e.g. the extracted SDK repo): fall through.
  }
  return FALLBACK_PUBLISHED_NAME;
}

/**
 * @param {{ sdkDir?: string, outDir?: string, build?: boolean, name?: string }} opts
 * @returns {string} absolute path to the packed tarball
 */
export function packPublished({
  sdkDir = SDK_DIR,
  outDir = join(tmpdir(), "morse-sdk-published"),
  build = true,
  name = publishedPackageName(),
} = {}) {
  if (build) {
    execFileSync("pnpm", ["run", "build"], { cwd: sdkDir, stdio: "inherit" });
  }
  if (!existsSync(join(sdkDir, "dist"))) {
    throw new Error(`No dist/ in ${sdkDir}. Run without --no-build (or run \`pnpm build\`).`);
  }

  const pkg = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
  const stage = mkdtempSync(join(tmpdir(), "morse-sdk-stage-"));
  try {
    // Same rewrite as release-typescript.yml's "Rewrite package name" step.
    pkg.name = name;
    writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    cpSync(join(sdkDir, "dist"), join(stage, "dist"), { recursive: true });
    for (const f of ["README.md", "LICENSE", "CHANGELOG.md"]) {
      if (existsSync(join(sdkDir, f))) cpSync(join(sdkDir, f), join(stage, f));
    }

    mkdirSync(outDir, { recursive: true });
    const out = execFileSync("npm", ["pack", "--pack-destination", resolve(outDir), "--json"], {
      cwd: stage,
      encoding: "utf8",
    });
    const filename = JSON.parse(out)[0].filename;
    return join(resolve(outDir), filename);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const tarball = packPublished({
    build: !args.includes("--no-build"),
    ...(outIdx >= 0 && args[outIdx + 1] ? { outDir: args[outIdx + 1] } : {}),
  });
  console.log(`\nPacked as ${publishedPackageName()}:`);
  console.log(tarball);
}
