/**
 * Presence scanner for tracked vector-store / memory client libraries.
 *
 * Mirrors the *intent* of the Python SDK's `morse_ai/instrumentation/imports.py`
 * (`scan_imported_libraries` + `AVImportWatcher`), adapted to what Node
 * actually offers:
 *
 * - Python can enumerate `sys.modules` to see what's *already imported* in
 *   the running process, and install a `MetaPathFinder` on `sys.meta_path`
 *   to observe *future* imports as they happen — both are stable, public
 *   parts of the import system.
 * - Node has no equivalent stable hook. There is no public "list of loaded
 *   modules" API (require.cache exists for CJS only, is undocumented for
 *   this purpose, and is empty/inapplicable under ESM), and observing
 *   future imports requires the experimental `--experimental-loader` /
 *   `module.register()` customization hooks, which a library cannot enable
 *   on behalf of its host application.
 *
 * So this module only supports what Python calls "package is installed",
 * not "package is imported": it resolves each tracked package's entry point
 * via Node's module resolution (`require.resolve` under `createRequire`,
 * which works for both CJS and ESM consumers without executing the module),
 * and reads its `package.json` version. There is no watcher/callback API —
 * callers that need "fires when the library is first used" should call
 * `scanInstalledLibraries()` again after their own instrumentation points
 * (e.g. inside a wrapped constructor) rather than relying on a global hook.
 */

import { createRequire } from "node:module";

/**
 * Tracked npm package names. Unlike PyPI, npm package names generally *are*
 * the specifier passed to `require`/`import`, so (unlike Python's
 * `TRACKED_LIBRARIES` + `_INSTALL_TO_MODULE` split) a single list suffices.
 *
 * Chosen to cover the same set of vector-store / memory clients as Python's
 * list (`chromadb`, `pinecone`, `weaviate-client`, `qdrant-client`, `mem0ai`,
 * `llama-index`), using each project's actual published npm package name.
 */
export const TRACKED_LIBRARIES: readonly string[] = [
  "chromadb",
  "@pinecone-database/pinecone",
  "weaviate-client",
  "weaviate-ts-client",
  "@qdrant/js-client-rest",
  "mem0ai",
  "llamaindex",
];

const requireFromHere = createRequire(import.meta.url);

/** Resolve `${pkg}/package.json` and read its `version` field, or "unknown" on any error. */
function getVersion(pkg: string): string {
  try {
    const pkgJson = requireFromHere(`${pkg}/package.json`) as {
      version?: unknown;
    };
    return typeof pkgJson.version === "string" ? pkgJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Return true if `pkg` can be resolved from the host app's module graph, without importing/executing it. */
function isInstalled(pkg: string): boolean {
  try {
    requireFromHere.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return `{ [libraryName]: version }` for every tracked library that is
 * currently resolvable (i.e. installed in the host app's `node_modules`).
 *
 * Never throws — a single library's resolution failure is swallowed and
 * that library is simply omitted from the result.
 */
export function scanInstalledLibraries(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const lib of TRACKED_LIBRARIES) {
    try {
      if (isInstalled(lib)) {
        result[lib] = getVersion(lib);
      }
    } catch {
      // Never let one bad entry break the scan.
    }
  }
  return result;
}
