/**
 * Browser replacement for `db-capture.ts` (MHQ-482 follow-up).
 *
 * `db-capture.ts` statically imports `@opentelemetry/instrumentation-pg`,
 * `-mysql2` and `@opentelemetry/instrumentation` (which reaches for node's
 * `module` via require-in-the-middle). A browser has no pg/mysql2 driver to
 * patch, so the whole module is inert there — but the static imports still
 * dragged those packages, and node `module`, into the browser graph.
 *
 * Swapped in by the esbuild plugin in `tsup.config.ts`; see
 * `otel-provider.browser.ts` for the full rationale. Only the symbols
 * `index.ts` imports need to exist here.
 */

/**
 * No-op: there is no database driver to instrument in a browser.
 *
 * Deliberately silent. `otel-provider.browser.ts::noteBrowserRuntime()`
 * already states that DB capture is Node-only, and it fires on
 * `configure()` — which `index.ts` always calls before this. A second
 * message would be noise, and this function runs even when the customer
 * never asked for DB capture.
 */
export function maybeEnableDbCaptureFromEnv(): void {}
