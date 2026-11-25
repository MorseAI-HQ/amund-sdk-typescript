#!/usr/bin/env node
/**
 * Build the `@morsehq-dev/sdk` compatibility shim.
 *
 * The shim's `exports` map is a byte-for-byte copy of `@amund/sdk`'s. For
 * every file that map points at, this script writes a one-line re-export of
 * the matching `@amund/sdk` subpath:
 *
 *   *.d.ts  -> `export * from "@amund/sdk/<sub>";`
 *   *.js    -> side-effect import of the deprecation notice, then
 *              `export * from "@amund/sdk/<sub>";`            (import / browser / default)
 *   *.cjs   -> require the deprecation notice, then
 *              `module.exports = require("@amund/sdk/<sub>");` (require)
 *
 * Re-exporting (never copying code) is what keeps `@morsehq-dev/sdk` and
 * `@amund/sdk` the SAME module instances: one SDK singleton, one transport.
 * The browser condition re-exports the bare `@amund/sdk/<sub>` specifier, so
 * the customer's bundler resolves `@amund/sdk`'s own browser build.
 *
 * Fails (exit 1) if the shim's package.json drifted from `@amund/sdk`
 * (exports map or version). `--write` re-syncs package.json instead.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = resolve(HERE, "..");
const SDK_DIR = resolve(SHIM_DIR, "../..");

const sdkPkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8"));
const shimPkgPath = join(SHIM_DIR, "package.json");
const shimPkg = JSON.parse(readFileSync(shimPkgPath, "utf8"));
const TARGET = sdkPkg.name; // "@amund/sdk"

const problems = [];
if (JSON.stringify(shimPkg.exports) !== JSON.stringify(sdkPkg.exports)) {
  problems.push(`exports map differs from ${TARGET}'s`);
}
if (shimPkg.version !== sdkPkg.version) {
  problems.push(`version ${shimPkg.version} != ${TARGET} ${sdkPkg.version}`);
}
if (shimPkg.dependencies?.[TARGET] !== "workspace:*") {
  problems.push(`dependencies["${TARGET}"] must be "workspace:*" (pnpm pack pins it to the exact version)`);
}
for (const k of ["main", "module", "types"]) {
  if (shimPkg[k] !== sdkPkg[k]) problems.push(`"${k}" differs from ${TARGET}'s`);
}

if (problems.length) {
  if (process.argv.includes("--write")) {
    shimPkg.exports = sdkPkg.exports;
    shimPkg.version = sdkPkg.version;
    shimPkg.dependencies = { ...shimPkg.dependencies, [TARGET]: "workspace:*" };
    for (const k of ["main", "module", "types"]) shimPkg[k] = sdkPkg[k];
    writeFileSync(shimPkgPath, JSON.stringify(shimPkg, null, 2) + "\n");
    console.log(`synced ${relative(process.cwd(), shimPkgPath)} with ${TARGET}`);
  } else {
    console.error(`@morsehq-dev/sdk shim is out of sync with ${TARGET}:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Run `node scripts/build.mjs --write` in compat/morsehq-dev-sdk to re-sync.");
    process.exit(1);
  }
}

/** @returns {Array<{ sub: string, file: string, kind: "types" | "esm" | "cjs" }>} */
function plan(exportsMap) {
  const out = [];
  for (const [key, value] of Object.entries(exportsMap)) {
    if (key === "./package.json") continue;
    const sub = key === "." ? TARGET : `${TARGET}/${key.slice(2)}`;
    const conds = typeof value === "string" ? { default: value } : value;
    for (const [cond, file] of Object.entries(conds)) {
      const kind = cond === "types" ? "types" : file.endsWith(".cjs") ? "cjs" : "esm";
      out.push({ sub, file, kind });
    }
  }
  return out;
}

const DIST = join(SHIM_DIR, "dist");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
copyFileSync(join(SHIM_DIR, "src", "deprecation.js"), join(DIST, "_deprecation.js"));
copyFileSync(join(SHIM_DIR, "src", "deprecation.cjs"), join(DIST, "_deprecation.cjs"));

const written = new Set();
for (const { sub, file, kind } of plan(shimPkg.exports)) {
  if (written.has(file)) continue;
  written.add(file);
  const abs = join(SHIM_DIR, file);
  mkdirSync(dirname(abs), { recursive: true });
  let rel = posix.relative(posix.dirname(file.replace(/^\.\//, "")), "dist");
  rel = rel === "" ? "." : rel.startsWith(".") ? rel : `./${rel}`;
  const spec = JSON.stringify(sub);
  let body;
  if (kind === "types") {
    body = `export * from ${spec};\n`;
  } else if (kind === "esm") {
    body = `import "${rel}/_deprecation.js";\nexport * from ${spec};\n`;
  } else {
    body = `"use strict";\nrequire("${rel}/_deprecation.cjs");\nmodule.exports = require(${spec});\n`;
  }
  writeFileSync(abs, `// @morsehq-dev/sdk compatibility shim: re-exports ${sub}.\n${body}`);
}
console.log(`@morsehq-dev/sdk shim: wrote ${written.size} re-export files -> ${TARGET}`);
