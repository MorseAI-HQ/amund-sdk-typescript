#!/usr/bin/env node
/**
 * Install the packed `@amund/sdk` + `@morsehq-dev/sdk` tarballs into a scratch
 * project OUTSIDE the repo (OS temp dir) and prove, the way a customer would
 * hit it, that every subpath of both packages:
 *
 *   - imports under ESM and requires under CJS,
 *   - returns the SAME module instances from the shim as from `@amund/sdk`,
 *   - type-checks under `moduleResolution: nodenext` (shim types re-export).
 *
 * Usage:
 *   node scripts/smoke-packed.mjs <amund-sdk.tgz> <morsehq-dev-sdk.tgz>
 *   node scripts/smoke-packed.mjs            # packs both first (pack:published --no-build)
 *
 * Needs network access to the npm registry for @amund/sdk's own dependencies.
 * Exit code 0 = all good. The scratch dir is removed unless KEEP_SMOKE_DIR=1.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { packPublished, SDK_DIR } from "./pack-published.mjs";

const args = process.argv.slice(2);
let sdkTgz;
let shimTgz;
if (args.length >= 2) {
  [sdkTgz, shimTgz] = args.map((a) => resolve(a));
} else {
  ({ sdk: sdkTgz, shim: shimTgz } = packPublished({ build: false }));
}

const work = mkdtempSync(join(tmpdir(), "amund-sdk-smoke-"));
console.log(`scratch project: ${work}`);

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: work, encoding: "utf8", ...opts });
}

try {
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify(
      {
        name: "amund-sdk-smoke",
        private: true,
        version: "0.0.0",
        dependencies: {
          "@amund/sdk": `file:${sdkTgz}`,
          "@morsehq-dev/sdk": `file:${shimTgz}`,
        },
        // The shim depends on the exact @amund/sdk version; point that at the
        // local tarball so the smoke works before anything is on the registry.
        overrides: { "@amund/sdk": "$@amund/sdk" },
      },
      null,
      2,
    ),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { stdio: "inherit" });

  const installed = (name) =>
    JSON.parse(readFileSync(join(work, "node_modules", name, "package.json"), "utf8"));
  const sdkPkg = installed("@amund/sdk");
  const shimPkg = installed("@morsehq-dev/sdk");
  if (shimPkg.dependencies?.["@amund/sdk"] !== sdkPkg.version) {
    throw new Error(
      `shim depends on @amund/sdk ${JSON.stringify(shimPkg.dependencies)}, expected exactly ${sdkPkg.version}`,
    );
  }
  if (JSON.stringify(shimPkg.exports) !== JSON.stringify(sdkPkg.exports)) {
    throw new Error("installed shim exports map differs from @amund/sdk's");
  }
  const subs = Object.keys(sdkPkg.exports)
    .filter((k) => k !== "./package.json")
    .map((k) => (k === "." ? "" : k.slice(1)));

  const MARK = "@morsehq-dev/sdk is deprecated";
  writeFileSync(
    join(work, "check.mjs"),
    `
const subs = ${JSON.stringify(subs)};
const warns = [];
const orig = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); };
for (const s of subs) {
  const real = await import("@amund/sdk" + s);
  const shim = await import("@morsehq-dev/sdk" + s);
  const keys = Object.keys(real).sort();
  if (keys.length === 0) throw new Error("ESM @amund/sdk" + s + " exported nothing");
  if (JSON.stringify(Object.keys(shim).sort()) !== JSON.stringify(keys)) throw new Error("ESM key mismatch on " + s);
  for (const k of keys) if (shim[k] !== real[k]) throw new Error("ESM instance mismatch " + s + " " + k);
}
console.warn = orig;
const n = warns.filter((w) => w.includes(${JSON.stringify(MARK)})).length;
if (n !== 1) throw new Error("ESM: expected 1 deprecation warning, got " + n);
const m = await import("@amund/sdk");
if (typeof m.init !== "function" || typeof m.version !== "string") throw new Error("ESM @amund/sdk surface broken");
console.log("ESM ok: " + subs.length + " subpaths, @amund/sdk " + m.version);
`,
  );
  writeFileSync(
    join(work, "check.cjs"),
    `
const subs = ${JSON.stringify(subs)};
const warns = [];
const orig = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); };
for (const s of subs) {
  const real = require("@amund/sdk" + s);
  const shim = require("@morsehq-dev/sdk" + s);
  if (shim !== real) throw new Error("CJS instance mismatch on " + s);
  if (Object.keys(real).length === 0) throw new Error("CJS @amund/sdk" + s + " exported nothing");
}
console.warn = orig;
const n = warns.filter((w) => w.includes(${JSON.stringify(MARK)})).length;
if (n !== 1) throw new Error("CJS: expected 1 deprecation warning, got " + n);
const morse = require("@morsehq-dev/sdk");
if (typeof morse.init !== "function") throw new Error("CJS surface broken");
console.log("CJS ok: " + subs.length + " subpaths");
`,
  );
  process.stdout.write(run(process.execPath, ["check.mjs"]));
  process.stdout.write(run(process.execPath, ["check.cjs"]));

  // Types: every subpath of both packages resolves under nodenext, and the
  // shim's declarations are the SDK's declarations.
  const lines = subs.flatMap((s, i) => [
    `import * as real${i} from "@amund/sdk${s}";`,
    `import * as shim${i} from "@morsehq-dev/sdk${s}";`,
    `export const same${i}: typeof real${i} = shim${i};`,
    `export const back${i}: typeof shim${i} = real${i};`,
  ]);
  lines.push(`import * as morse from "@morsehq-dev/sdk";`);
  lines.push(`export const initFn: (o?: { apiKey?: string }) => void = morse.init;`);
  writeFileSync(join(work, "types.mts"), lines.join("\n") + "\n");
  writeFileSync(
    join(work, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["types.mts"],
    }),
  );
  const tsc = join(dirname(createRequire(join(SDK_DIR, "package.json")).resolve("typescript")), "..", "bin", "tsc");
  run(process.execPath, [tsc, "-p", "tsconfig.json"], { stdio: "inherit" });
  console.log(`types ok: ${subs.length} subpaths x 2 packages (nodenext)`);
  console.log("smoke-packed: PASS");
} finally {
  if (process.env.KEEP_SMOKE_DIR === "1") console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
