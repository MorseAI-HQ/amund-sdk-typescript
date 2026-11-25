/**
 * `@morsehq-dev/sdk` shim checks (node:test). Needs both builds first:
 *   pnpm --filter @amundai/sdk build && pnpm --filter @morsehq-dev/sdk build
 *
 * Proves, for EVERY subpath in the exports map, that the shim resolves under
 * ESM and CJS and hands back the very same module instances as `@amundai/sdk`,
 * and that the deprecation notice prints exactly once per process (and not at
 * all when the user has switched warnings / the SDK off).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SHIM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_DIR = resolve(SHIM_DIR, "../..");
const shimPkg = JSON.parse(readFileSync(join(SHIM_DIR, "package.json"), "utf8"));
const sdkPkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8"));
const require = createRequire(join(SHIM_DIR, "package.json"));

const SUBPATHS = Object.keys(shimPkg.exports)
  .filter((k) => k !== "./package.json")
  .map((k) => (k === "." ? "" : k.slice(1)));

const MESSAGE_MARK = "@morsehq-dev/sdk is deprecated";

test("package.json mirrors @amundai/sdk (exports, version, entry fields)", () => {
  assert.equal(sdkPkg.name, "@amundai/sdk");
  assert.equal(shimPkg.name, "@morsehq-dev/sdk");
  assert.deepEqual(shimPkg.exports, sdkPkg.exports);
  assert.equal(shimPkg.version, sdkPkg.version);
  for (const k of ["main", "module", "types"]) assert.equal(shimPkg[k], sdkPkg[k]);
  assert.equal(shimPkg.dependencies["@amundai/sdk"], "workspace:*");
  assert.ok(SUBPATHS.length >= 9, `expected >= 9 subpaths, got ${SUBPATHS.length}`);
});

test("every file the exports map names exists in the shim build", () => {
  for (const value of Object.values(shimPkg.exports)) {
    for (const file of typeof value === "string" ? [value] : Object.values(value)) {
      assert.ok(existsSync(join(SHIM_DIR, file)), `missing ${file} (run the shim build)`);
    }
  }
});

for (const sub of SUBPATHS) {
  test(`ESM: @morsehq-dev/sdk${sub} === @amundai/sdk${sub}`, async () => {
    const shim = await import(`@morsehq-dev/sdk${sub}`);
    const real = await import(`@amundai/sdk${sub}`);
    const keys = Object.keys(real).sort();
    assert.ok(keys.length > 0, `@amundai/sdk${sub} exported nothing`);
    assert.deepEqual(Object.keys(shim).sort(), keys);
    for (const k of keys) assert.equal(shim[k], real[k], `${sub || "."}: ${k} is a different instance`);
  });

  test(`CJS: require("@morsehq-dev/sdk${sub}") is require("@amundai/sdk${sub}")`, () => {
    const shim = require(`@morsehq-dev/sdk${sub}`);
    const real = require(`@amundai/sdk${sub}`);
    assert.equal(shim, real);
  });
}

function runChild(code, { env = {}, args = [] } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const k of ["NODE_NO_WARNINGS", "AMUND_DISABLED", "MORSE_DISABLED"]) {
    if (!(k in env)) delete childEnv[k];
  }
  // Child stderr is merged into stdout so the count sees every console.warn.
  return execFileSync(process.execPath, [...args, "--input-type=module", "-e", code], {
    cwd: SHIM_DIR,
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const IMPORT_EVERYTHING = `
  import { createRequire } from "node:module";
  const require = createRequire(process.cwd() + "/package.json");
  const subs = ${JSON.stringify(SUBPATHS)};
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  for (const s of subs) { await import("@morsehq-dev/sdk" + s); require("@morsehq-dev/sdk" + s); }
  console.warn = orig;
  process.stdout.write(JSON.stringify(warns.filter((w) => w.includes(${JSON.stringify(MESSAGE_MARK)}))));
`;

test("deprecation notice prints exactly once across all subpaths, ESM + CJS", () => {
  const warns = JSON.parse(runChild(IMPORT_EVERYTHING));
  assert.equal(warns.length, 1, JSON.stringify(warns));
  assert.match(warns[0], /@amundai\/sdk/);
});

for (const [label, opts] of [
  ["NODE_NO_WARNINGS=1", { env: { NODE_NO_WARNINGS: "1" } }],
  ["--no-deprecation", { args: ["--no-deprecation"] }],
  ["MORSE_DISABLED=1", { env: { MORSE_DISABLED: "1" } }],
  ["AMUND_DISABLED=true", { env: { AMUND_DISABLED: "true" } }],
]) {
  test(`deprecation notice is suppressed under ${label}`, () => {
    assert.deepEqual(JSON.parse(runChild(IMPORT_EVERYTHING, opts)), []);
  });
}

test("AMUND_DISABLED=0 beats MORSE_DISABLED=1, so the notice still prints", () => {
  const warns = JSON.parse(
    runChild(IMPORT_EVERYTHING, { env: { AMUND_DISABLED: "0", MORSE_DISABLED: "1" } }),
  );
  assert.equal(warns.length, 1);
});

test("deprecation.js and deprecation.cjs carry the same message", async () => {
  const esm = await import(join(SHIM_DIR, "src", "deprecation.js"));
  const cjs = require(join(SHIM_DIR, "src", "deprecation.cjs"));
  assert.equal(esm.MESSAGE, cjs.MESSAGE);
});
