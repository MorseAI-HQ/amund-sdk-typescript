/**
 * Browser replacement for `auto-detect.ts` (MHQ-482 follow-up).
 *
 * `auto-detect.ts` already no-ops at RUNTIME outside Node — its own
 * docstring says so — but it reaches for `node:module`'s `createRequire` /
 * `Module` in a static top-level import, so a bundler still had to resolve
 * `module` for the browser graph. The runtime guard was never the problem;
 * the import was.
 *
 * Nothing here is a behaviour change: zero-config adapter auto-detect works
 * by hooking `require()` to patch LLM SDKs as they load, and a browser has
 * no `require` to hook. See `otel-provider.browser.ts` for the full
 * rationale and the build wiring.
 */

/** No-op: there is no `require` to hook in a browser. */
export async function installAdapters(): Promise<void> {}

/** No state to reset in the browser build. */
export function _resetForTesting(): void {}
