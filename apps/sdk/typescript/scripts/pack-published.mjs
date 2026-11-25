#!/usr/bin/env node
/**
 * `pnpm pack:published` — pack the SDK exactly as a release ships it.
 *
 * Since the Amund rebrand the in-repo name IS the published name (`@amund/sdk`),
 * so there is no rename step any more (through 0.8.0 the release workflow rewrote
 * `@morsehq/sdk` to `@morsehq-dev/sdk`, MHQ-1411). A release publishes TWO
 * tarballs, both produced by `pnpm pack` (which pins the shim's
 * `"@amund/sdk": "workspace:*"` dependency to the exact version):
 *
 *   - `@amund/sdk`         — this package
 *   - `@morsehq-dev/sdk`   — the compatibility shim in compat/morsehq-dev-sdk/
 *
 * `.github/workflows/release-typescript.yml` calls this script, smoke-tests the
 * tarballs with `scripts/smoke-packed.mjs`, and publishes those same files.
 *
 * Usage:
 *   pnpm pack:published                 # build both, pack into $TMPDIR/amund-sdk-published
 *   pnpm pack:published --no-build      # reuse existing dist/ folders
 *   pnpm pack:published --out <dir>     # choose the output directory
 *
 * Prints the two absolute tarball paths on the last two lines of stdout
 * (`@amund/sdk` first, then the shim).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SDK_DIR = resolve(HERE, "..");
export const SHIM_DIR = join(SDK_DIR, "compat", "morsehq-dev-sdk");

function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/** The npm name a package directory publishes under (its package.json `name`). */
export function publishedPackageName(dir = SDK_DIR) {
  return readPkg(dir).name;
}

/** `@scope/name` + version -> the file name `npm pack` / `pnpm pack` writes. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/**
 * Pack one package directory with `pnpm pack` (so `workspace:` ranges are
 * replaced by real versions, as `pnpm publish` would).
 *
 * @param {{ dir: string, outDir: string }} opts
 * @returns {string} absolute path to the tarball
 */
export function packDir({ dir, outDir }) {
  const pkg = readPkg(dir);
  if (!existsSync(join(dir, "dist"))) {
    throw new Error(`No dist/ in ${dir}. Build first (or run without --no-build).`);
  }
  const dest = resolve(outDir);
  mkdirSync(dest, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", dest], {
    cwd: dir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarball = join(dest, tarballName(pkg.name, pkg.version));
  if (!existsSync(tarball)) throw new Error(`pnpm pack did not write ${tarball}`);
  return tarball;
}

/**
 * Build (optionally) and pack `@amund/sdk` and the `@morsehq-dev/sdk` shim.
 *
 * @param {{ outDir?: string, build?: boolean, sdkDir?: string, shimDir?: string }} opts
 * @returns {{ sdk: string, shim: string }} absolute tarball paths
 */
export function packPublished({
  outDir = join(tmpdir(), "amund-sdk-published"),
  build = true,
  sdkDir = SDK_DIR,
  shimDir = SHIM_DIR,
} = {}) {
  if (build) {
    execFileSync("pnpm", ["run", "build"], { cwd: sdkDir, stdio: "inherit" });
    execFileSync("pnpm", ["run", "build"], { cwd: shimDir, stdio: "inherit" });
  }
  return {
    sdk: packDir({ dir: sdkDir, outDir }),
    shim: packDir({ dir: shimDir, outDir }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const { sdk, shim } = packPublished({
    build: !args.includes("--no-build"),
    ...(outIdx >= 0 && args[outIdx + 1] ? { outDir: args[outIdx + 1] } : {}),
  });
  console.log(`\nPacked ${publishedPackageName(SDK_DIR)} and ${publishedPackageName(SHIM_DIR)}:`);
  console.log(sdk);
  console.log(shim);
}
