/**
 * Non-invasive error isolation — the foundational SDK guarantee.
 *
 * Mirrors Python's `_internal/errors.py` `@absorb_errors` decorator. Every
 * public SDK function and every adapter-installed wrapper is wrapped with
 * `absorbErrors()`. The wrapper catches all exceptions and reports them
 * out-of-band to Morse's own diagnostics endpoint, then returns a benign value
 * (typically `undefined`) instead of propagating.
 *
 * Foundational principle:
 *
 *     Telemetry must never break the host application.
 *
 * The customer's call returns its original result (or `undefined`)
 * regardless of whether the SDK's recording path succeeded.
 *
 * Note on async: TypeScript-land has no `KeyboardInterrupt` equivalent —
 * the analogue is "no exceptions are special". We absorb everything,
 * and rely on Node's `process.exit` / browser navigation to tear down
 * the runtime cleanly.
 */

import { report } from "./diagnostics";

export interface AbsorbErrorsOptions {
  /**
   * Stable identifier for grouping. Used for server-side grouping and
   * the rate limiter (max 100 events per fingerprint per minute).
   */
  fingerprint: string;
  /** Optional metadata attached to the report; scrubbed against an allow-list. */
  extra?: Record<string, unknown>;
}

/**
 * Wrap a synchronous function so that any thrown exception is absorbed
 * (reported out-of-band) instead of propagating. Returns `undefined` on
 * absorbed error.
 */
export function absorbErrorsSync<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  options: AbsorbErrorsOptions,
): (...args: TArgs) => TReturn | undefined {
  return (...args: TArgs): TReturn | undefined => {
    try {
      return fn(...args);
    } catch (err) {
      report(err, options);
      return undefined;
    }
  };
}

/**
 * Wrap an async function so that any rejection or thrown exception is
 * absorbed (reported out-of-band) instead of propagating. Returns
 * `undefined` on absorbed error.
 */
export function absorbErrorsAsync<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: AbsorbErrorsOptions,
): (...args: TArgs) => Promise<TReturn | undefined> {
  return async (...args: TArgs): Promise<TReturn | undefined> => {
    try {
      return await fn(...args);
    } catch (err) {
      report(err, options);
      return undefined;
    }
  };
}

/**
 * Higher-order alias chosen to read like the Python decorator: pass a
 * function in, get a wrapped version back. Resolves to the sync or async
 * variant based on the runtime return value (a Promise). Defaults to
 * sync at the type level; use `absorbErrorsAsync` directly for proper
 * async typing.
 */
export const absorbErrors = absorbErrorsSync;
