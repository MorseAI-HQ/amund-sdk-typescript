/**
 * Browser replacement for `infra-capture.ts` (INFRACAP).
 *
 * The Node module reaches for `node:diagnostics_channel` (HTTP capture) and
 * the OTel require-in-the-middle instrumentations (DB and queue capture), none
 * of which exist in a browser. Swapped in by the esbuild plugin in
 * `tsup.config.ts`; see `otel-provider.browser.ts` for the full rationale.
 */

/** No-op: a browser has no driver, queue client or Node http stack to observe. */
export function maybeEnableInfraCaptureFromEnv(opts: { endpoint?: string } = {}): void {
  void opts;
}
