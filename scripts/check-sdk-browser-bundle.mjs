#!/usr/bin/env node
/**
 * Fail the build if the TS SDK's browser bundle reaches for Node-only APIs.
 *
 * Why this exists — and why a build job would NOT have caught it:
 * `next build` (webpack, production) tolerated the Node-only imports that
 * `next dev --turbopack` rejected outright, so CI's existing
 * `turbo build --filter=@morsehq/web` passed while every developer on a
 * clean checkout hit a hard build error. The regression was invisible for
 * another reason too: `dist/` is gitignored, so machines with output built
 * before the breakage kept working. A static assertion on the built artifact
 * catches both cases in ~50ms, with no dev server and no bundler involved.
 *
 * What it checks: no module under `dist/browser/` may import a Node builtin
 * or a Node-only OpenTelemetry package. Those belong exclusively to the Node
 * build (`dist/`), which this script deliberately does NOT inspect.
 *
 * If this fails, the fix is a browser stub + an entry in the `browserStubs`
 * plugin filter in `apps/sdk/typescript/tsup.config.ts` — NOT an exception
 * here, and never a `resolve.fallback` in a consuming app (the SDK ships to
 * npm; a consumer's bundler config cannot be part of our fix).
 *
 * Usage: node scripts/check-sdk-browser-bundle.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER_DIST = join(REPO_ROOT, "apps", "sdk", "typescript", "dist", "browser");

/** Node builtins the browser has no answer for. `node:`-prefixed or bare. */
const NODE_BUILTINS = [
  "async_hooks",
  "module",
  "fs",
  "path",
  "http",
  "https",
  "net",
  "tls",
  "child_process",
  "worker_threads",
  "perf_hooks",
  "diagnostics_channel",
];

/**
 * Node-only OTel packages. Listed explicitly rather than matched by prefix:
 * plenty of `@opentelemetry/*` packages (`api`, `core`, `sdk-trace-base`)
 * are perfectly browser-safe and are legitimately bundled.
 */
const NODE_ONLY_PACKAGES = [
  "@opentelemetry/sdk-trace-node",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/instrumentation",
  "@opentelemetry/instrumentation-pg",
  "@opentelemetry/instrumentation-mysql2",
  "require-in-the-middle",
  "import-in-the-middle",
];

/** `import ... from "x"`, `export ... from "x"`, `require("x")`, `import("x")`. */
function specifiersIn(source) {
  const found = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s*["']([^"']+)["']/gm,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) found.add(match[1]);
  }
  return found;
}

function isNodeOnly(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.includes(bare)) return true;
  return NODE_ONLY_PACKAGES.some((pkg) => bare === pkg || bare.startsWith(`${pkg}/`));
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|cjs)$/.test(entry.name)) yield full;
  }
}

if (!existsSync(BROWSER_DIST)) {
  console.error(
    `check-sdk-browser-bundle: ${relative(REPO_ROOT, BROWSER_DIST)} not found — ` +
      "build the SDK first (pnpm --filter @morsehq/sdk build).",
  );
  process.exit(1);
}

const violations = [];
let scanned = 0;
for (const file of walk(BROWSER_DIST)) {
  scanned += 1;
  for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
    if (isNodeOnly(specifier)) {
      violations.push({ file: relative(REPO_ROOT, file), specifier });
    }
  }
}

if (scanned === 0) {
  console.error("check-sdk-browser-bundle: no bundle files found — build looks empty.");
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `check-sdk-browser-bundle: ${violations.length} Node-only import(s) in the browser bundle:\n`,
  );
  for (const { file, specifier } of violations) {
    console.error(`  ${file}\n    imports "${specifier}"`);
  }
  console.error(
    "\nAdd a `<module>.browser.ts` stub and list it in the `browserStubs` plugin\n" +
      "filter in apps/sdk/typescript/tsup.config.ts. Do not add an exception here.",
  );
  process.exit(1);
}

console.log(`check-sdk-browser-bundle: OK — ${scanned} browser bundle files, no Node-only imports.`);
