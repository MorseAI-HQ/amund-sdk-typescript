/**
 * Auto-detect installed AI SDKs and install the matching adapter.
 *
 * Node port of the Python SDK's `_internal/auto_detect.py` (auto-instrumentation
 * zero-config instrumentation): when the Morse SDK initializes, scan for
 * already-loaded target packages and install each detected adapter. For
 * packages not yet loaded, register a hook so the adapter installs as soon
 * as the customer's code requires it.
 *
 * Customer flow becomes:
 *
 *     npm install @amundai/sdk
 *     export AMUND_API_KEY=mhq_...
 *     // ... existing @anthropic-ai/sdk / ai code is now traced ...
 *
 * No `morse.wrapAnthropic()` / `morse.instrumentAnthropic()` call required.
 *
 * ---------------------------------------------------------------------
 * Node vs. Python — why this module's SCOPE is narrower than auto_detect.py
 * ---------------------------------------------------------------------
 *
 * Python's `sys.modules` is a single global dict of every imported module,
 * and `importlib.abc.MetaPathFinder` gives a clean, built-in hook that
 * fires for BOTH `import x` and `from x import y`, regardless of package
 * shape. Node has no equivalent: there is no single "loaded modules"
 * registry that covers both CJS and ESM, and Node's ESM loader hook
 * (`node:module`'s `register()`) runs the customization hook in a
 * dedicated loader thread with structured-clone message-passing back to
 * the main thread — it cannot synchronously call back into an adapter's
 * `install()` in the main realm, and building an async message-passing
 * bridge just for this is disproportionate to what a v1 zero-config port
 * needs. So this port targets Node's CommonJS `require` machinery only:
 *
 *   - "Already loaded" scan: `require.resolve(name)` (no side effect,
 *     mirrors `importlib.util.find_spec`) + membership in `require.cache`
 *     (mirrors `name in sys.modules`).
 *   - "Not yet loaded" hook: patch `Module.prototype.require` so any
 *     `require(name)` call — including the one Node performs internally
 *     when a CJS-authored package is `import`-ed from an ESM file, which
 *     is how `@anthropic-ai/sdk` and `ai` are typically consumed — fires
 *     the adapter's install() once the module body has finished
 *     evaluating. Pure-ESM packages loaded via the native ESM loader
 *     (no CJS `require` in the chain) are NOT observed by this hook; for
 *     those, `wrapX()` / `instrumentX()` remain the documented manual path.
 *
 * A second, orthogonal scope narrowing: not every Morse TS adapter has a
 * module-level monkey-patch entry point the way Python's adapters do.
 * `instrumentAnthropic()` patches `Messages.prototype.create` — a plain
 * mutable property on a class, present regardless of module system — so
 * auto-detect can install it exactly like Python's `install()` functions.
 * `ai` (Vercel AI SDK) CANNOT be silently patched this way: its exports are
 * plain functions (no prototype), and ships pure-ESM, so Node exposes
 * `streamText`/`generateText`/`generateObject` as non-configurable
 * getter-only properties even through the CJS interop `require()` path —
 * reassigning them throws. Confirmed via a bare Node repro during MHQ-482
 * OSS dogfooding (`bizops/dogfood/ai-sdk-preview-rag.md`); see
 * `../vercel-ai/index.ts`'s module doc for the full story. `ai` is a
 * `DETECT_ONLY_TARGETS` entry pointing at `createTracedVercelAI()`. The
 * `openai-agents`, `langgraph`, and `anthropic-agent-sdk` TS adapters are
 * per-instance only (`wrapRunnerWithFullInstrumentation(runner)`, `new
 * MorseCallbackHandler()`, `wrapClaudeAgentSDKWithFullInstrumentation(
 * client)`) — there is no global hook point to patch without the
 * customer's own `Runner` / `ClaudeSDKClient` instance in hand. Auto-detect
 * still DETECTS these (a one-time informational log pointing at the manual
 * wrap call) but cannot silently instrument them. See `DETECT_ONLY_TARGETS`
 * below.
 *
 * Idempotency: each `FULL_INSTALL_TARGETS[...].install()` call delegates to
 * an adapter function that is itself idempotent (checks a sentinel on the
 * target module). Calling `installAdapters()` repeatedly is safe.
 *
 * Opt-out: `AMUND_DISABLE_AUTO_DETECT=1` skips this step entirely.
 * Customers can still call the adapter `wrapX()` / `instrumentX()`
 * functions directly.
 *
 * Implementation note on the `node:module` import: unlike the optional
 * peer-dependency imports elsewhere in this SDK (e.g. `@anthropic-ai/sdk`
 * in `anthropic/index.ts`, dynamic-imported via a `Function`-eval trick so
 * bundlers never try to statically resolve a package the customer may not
 * have installed), `node:module` is a Node CORE builtin — always present in
 * any Node runtime, nothing to dodge at bundle time. It's imported
 * statically here and every call site is still runtime-guarded by a
 * `typeof process !== "undefined" && process.versions?.node` check, so
 * this module is a safe no-op outside Node (browser bundles, edge
 * runtimes). A dynamic-`import()`-via-`Function`-eval was tried first but
 * rejected: it throws `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` under
 * Vitest's VM-sandboxed test execution, making the require/hook mechanics
 * untestable — a static import has no such problem.
 */

import { createRequire, Module } from "node:module";

import { instrumentAnthropic } from "../anthropic";
import { isAutoDetectDisabled } from "./env";

/* ------------------------------------------------------------------------ */
/*  Target catalogues                                                        */
/* ------------------------------------------------------------------------ */

interface FullInstallTarget {
  /** Best-effort installer given the resolved module namespace object. */
  install: (mod: unknown) => Promise<unknown>;
}

/**
 * Packages with a genuine module-level install entry point — auto-detect
 * can silently instrument these without any customer-supplied instance.
 */
const FULL_INSTALL_TARGETS: Record<string, FullInstallTarget> = {
  "@anthropic-ai/sdk": {
    install: (mod) => instrumentAnthropic({ anthropicModule: mod }),
  },
};

/**
 * Packages whose Morse adapter only works against a customer-supplied
 * instance (Runner, ClaudeSDKClient, a LangGraph callback handler). These
 * are detected (best-effort, package-presence only) so we can point the
 * customer at the right manual call — see the module doc comment above for
 * why silent auto-install isn't possible for these yet.
 */
const DETECT_ONLY_TARGETS: Record<string, string> = {
  "@openai/agents": "wrapRunnerWithFullInstrumentation(runner) from '@amundai/sdk/openai-agents'",
  "@langchain/langgraph":
    "new MorseCallbackHandler() from '@amundai/sdk/langgraph', passed via { callbacks: [...] }",
  // MHQ-936: same shape as `ai` below. The package exports a top-level
  // `query` that is read-only and non-configurable, so it cannot be patched
  // in place; and it has no client class to patch a prototype on
  // (`ClaudeSDKClient` is the *Python* package's API and has never existed
  // here). wrapClaudeAgentQuery() returns a traced replacement instead.
  "@anthropic-ai/claude-agent-sdk":
    "wrapClaudeAgentQuery(query) from '@amundai/sdk/anthropic-agent-sdk' — call its returned function in place of the package's own query()",
  // MHQ-758: `ai`'s exports can't be patched in place (frozen ESM getters,
  // no prototype to patch) — createTracedVercelAI() returns replacement
  // functions instead. See `../vercel-ai/index.ts`'s module doc.
  ai: "createTracedVercelAI() from '@amundai/sdk/vercel-ai' — use its returned streamText/generateText/generateObject in place of ai's own",
};

/* ------------------------------------------------------------------------ */
/*  Node `require` access                                                    */
/* ------------------------------------------------------------------------ */

interface NodeRequireLike {
  (id: string): unknown;
  resolve: (id: string) => string;
  cache: Record<string, unknown>;
}

/** True when running under real Node (not a browser bundle / edge runtime). */
function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function getNodeRequire(): NodeRequireLike | null {
  if (!isNodeRuntime()) return null;
  try {
    // `import.meta.url` is standard ESM syntax (not a Node built-in) —
    // safe for bundlers to see statically. When this file is compiled to
    // CJS (tsup's CJS output target), esbuild shims it automatically.
    return createRequire(import.meta.url) as unknown as NodeRequireLike;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/*  Module-level state                                                       */
/* ------------------------------------------------------------------------ */

const firedFullInstall = new Set<string>();
const loggedDetectOnly = new Set<string>();
const lazyTargets = new Set<string>();
let hookInstalled = false;
type RequireFn = (this: unknown, id: string) => unknown;
let originalRequire: RequireFn | null = null;

function logger(message: string): void {
  console.info(message);
}

/* ------------------------------------------------------------------------ */
/*  Install one full-install target, guarding against a double-fire         */
/* ------------------------------------------------------------------------ */

async function installFullTarget(name: string, mod: unknown): Promise<void> {
  if (firedFullInstall.has(name)) return;
  firedFullInstall.add(name);
  const target = FULL_INSTALL_TARGETS[name];
  if (!target) return;
  try {
    await target.install(mod);
  } catch {
    // Never let a single adapter's install failure break the others —
    // the adapter's own install() is already absorbErrors-wrapped, this
    // is a defensive extra layer mirroring Python's `_install_one`.
  }
}

function logDetectOnlyIfPresent(nodeRequire: NodeRequireLike, name: string): void {
  if (loggedDetectOnly.has(name)) return;
  try {
    nodeRequire.resolve(name);
  } catch {
    return; // not installed — nothing to log
  }
  loggedDetectOnly.add(name);
  logger(
    `morse: detected "${name}" — no zero-config path for this SDK yet. ` +
      `Call ${DETECT_ONLY_TARGETS[name]} to instrument it.`,
  );
}

/* ------------------------------------------------------------------------ */
/*  Lazy hook — fires installFullTarget() when a target is `require()`d     */
/*  for the first time after installAdapters() ran.                         */
/* ------------------------------------------------------------------------ */

function installLazyHook(): void {
  if (hookInstalled) return;
  originalRequire = Module.prototype.require as RequireFn;
  const original = originalRequire;
  Module.prototype.require = function patchedRequire(this: unknown, id: string): unknown {
    const result = original.call(this, id);
    if (lazyTargets.has(id) && !firedFullInstall.has(id)) {
      // Fire-and-forget — telemetry install must never block or throw back
      // at the customer's require() call.
      void installFullTarget(id, result);
    }
    return result;
  } as typeof Module.prototype.require;
  hookInstalled = true;
}

function uninstallLazyHook(): void {
  if (hookInstalled && originalRequire) {
    Module.prototype.require = originalRequire as typeof Module.prototype.require;
  }
  hookInstalled = false;
  originalRequire = null;
}

/* ------------------------------------------------------------------------ */
/*  Public entry point                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Scan for already-loaded target packages and install adapters for any
 * that are present. For packages not yet loaded, register a lazy hook so
 * they get instrumented the moment the customer's code requires them.
 *
 * Idempotent and safe to call repeatedly — every `morse.init()` (and the
 * env-based lazy auto-init path) goes through here.
 *
 * Honors `AMUND_DISABLE_AUTO_DETECT=1` and returns immediately. No-ops
 * outside Node (e.g. a browser bundle) since there is no `require` to hook.
 */
export async function installAdapters(): Promise<void> {
  if (isAutoDetectDisabled()) return;

  const nodeRequire = getNodeRequire();
  if (!nodeRequire) return;

  const installPromises: Array<Promise<void>> = [];

  for (const name of Object.keys(FULL_INSTALL_TARGETS)) {
    if (firedFullInstall.has(name)) continue;
    let resolvedPath: string | undefined;
    try {
      resolvedPath = nodeRequire.resolve(name);
    } catch {
      continue; // package not installed at all — nothing to detect or hook
    }
    if (resolvedPath in nodeRequire.cache) {
      // Already loaded — install now.
      try {
        const mod = nodeRequire(name);
        installPromises.push(installFullTarget(name, mod));
      } catch {
        // Loading a cached module should never throw, but stay defensive.
      }
    } else {
      // Not loaded yet — register for the lazy require() hook.
      lazyTargets.add(name);
    }
  }

  if (lazyTargets.size > 0) {
    installLazyHook();
  }

  for (const name of Object.keys(DETECT_ONLY_TARGETS)) {
    logDetectOnlyIfPresent(nodeRequire, name);
  }

  await Promise.all(installPromises);
}

/**
 * Reset all auto-detect state for tests: unpatches `Module.prototype
 * .require`, clears the fired/logged/lazy sets. Not part of the public API.
 * @internal
 */
export function _resetForTesting(): void {
  uninstallLazyHook();
  firedFullInstall.clear();
  loggedDetectOnly.clear();
  lazyTargets.clear();
}

/** @internal test-only accessors */
export const _internalsForTesting = {
  FULL_INSTALL_TARGETS,
  DETECT_ONLY_TARGETS,
  get lazyTargets(): ReadonlySet<string> {
    return lazyTargets;
  },
  get hookInstalled(): boolean {
    return hookInstalled;
  },
};
