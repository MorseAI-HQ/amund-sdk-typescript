import path from "node:path";

import { defineConfig, type Options } from "tsup";

import pkg from "./package.json" with { type: "json" };

// Nine public entry points (MHQ-747 added the plain OpenAI adapter):
//   - `src/index.ts`                       → `@morsehq/sdk`
//   - `src/vercel-ai/index.ts`             → `@morsehq/sdk/vercel-ai`
//   - `src/anthropic/index.ts`             → `@morsehq/sdk/anthropic`
//   - `src/anthropic-agent-sdk/index.ts`   → `@morsehq/sdk/anthropic-agent-sdk`
//   - `src/openai-agents/index.ts`         → `@morsehq/sdk/openai-agents`
//   - `src/openai/index.ts`                → `@morsehq/sdk/openai`
//   - `src/langgraph/index.ts`             → `@morsehq/sdk/langgraph`
//   - `src/langchain/index.ts`             → `@morsehq/sdk/langchain`
//   - `src/integrations/pino.ts`           → `@morsehq/sdk/integrations/pino`
//
// tsup preserves the directory layout under `dist/` when given a list of
// entries (vs. a glob), so the resulting paths match the `exports` map in
// package.json. Both the Node and the browser build use this same list, so a
// new adapter can never be browser-safe in one build and broken in the other.
const ENTRY = [
  "src/index.ts",
  "src/vercel-ai/index.ts",
  "src/anthropic/index.ts",
  "src/anthropic-agent-sdk/index.ts",
  "src/openai-agents/index.ts",
  "src/openai/index.ts",
  "src/langgraph/index.ts",
  "src/langchain/index.ts",
  "src/integrations/pino.ts",
];

const SHARED: Options = {
  // Single-source the SDK version: package.json is the only declaration, and
  // esbuild substitutes it into `SDK_VERSION` (see _internal/transport.ts) at
  // build time. Running from source (vitest) leaves it undefined and falls
  // back to "0.0.0-dev", which is correct — a source checkout has no release
  // version.
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  entry: ENTRY,
  format: ["esm", "cjs"],
  target: "es2022",
  sourcemap: true,
  treeshake: true,
  // MHQ-758: `splitting: false` made every entry point above a fully
  // self-contained bundle — each with its OWN copy of `_internal/tracing.ts`
  // / `otel-provider.ts` module-scope singletons (the `OtelEngine`,
  // `transport`, `lastTrace`). `morse.init()` called via the top-level
  // `@morsehq/sdk` entry never reached the state any subpath adapter
  // (`/vercel-ai`, `/anthropic`, `/langgraph`, ...) actually read from —
  // spans silently went nowhere. Confirmed via `dist/*/index.js` all
  // independently inlining `sendTrace`/`getEngine`, and via an `https`
  // interception test showing zero OTLP export calls. `splitting: true`
  // makes esbuild extract shared internal modules into common chunk files
  // every entry imports, restoring one shared singleton across the package
  // — the standard fix for multi-entry-point library bundles with
  // module-level state.
  splitting: true,
  minify: false,
};

/**
 * Swap the two Node-only internals for their browser stubs.
 *
 * Matched on the resolved module path, not on the import specifier: the same
 * file is imported as both `./otel-provider` (from `_internal/`) and
 * `./_internal/otel-provider` (from `src/`), so an `alias` map keyed on the
 * specifier would silently miss one spelling — exactly the class of failure
 * this build exists to prevent. One `onResolve` rule covers every caller,
 * including any added later.
 */
function browserStubs(): NonNullable<Options["esbuildPlugins"]>[number] {
  return {
    name: "morse-browser-stubs",
    setup(build) {
      build.onResolve(
        { filter: /(^|\/)(otel-provider|db-capture|infra-capture|auto-detect)$/ },
        (args) => ({
          path: path.resolve(args.resolveDir, `${args.path}.browser.ts`),
        }),
      );
    },
  };
}

export default defineConfig([
  {
    ...SHARED,
    // Node build — the default `import`/`require` conditions.
    clean: true,
    // Types are generated once here and shared by both builds: the browser
    // stubs deliberately mirror the Node modules' public shape, so a second
    // .d.ts would be a duplicate that can only drift.
    dts: true,
  },
  {
    ...SHARED,
    // Browser build — selected automatically by bundlers via package.json's
    // `"browser"` export condition. No consumer configuration required.
    outDir: "dist/browser",
    platform: "browser",
    // `clean` would wipe dist/ *after* the Node build wrote it.
    clean: false,
    dts: false,
    esbuildPlugins: [browserStubs()],
  },
]);
