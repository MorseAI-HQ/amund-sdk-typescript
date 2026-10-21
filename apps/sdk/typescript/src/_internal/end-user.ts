/**
 * SETUP-10: opt-in end-user capture shared by the OpenAI and Anthropic adapters.
 *
 * Off unless `init({ captureEndUser: true })`. Only a hash is ever stored
 * (`"h:" + sha256(value).hex.slice(0, 32)`); the raw value never leaves this
 * function. A `userId` the app already set (`run({ userId })`) always wins,
 * and `customer_id` is never touched.
 */

import { getActiveTraceState, isCaptureEndUser } from "./tracing";

/**
 * Node-only sync SHA-256; returns undefined where `node:crypto` is unavailable
 * (browsers), in which case nothing is captured. `process.getBuiltinModule`
 * works in ESM; `require` covers CJS and older Node.
 */
function sha256HexNode(text: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = process as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cryptoMod: any = proc.getBuiltinModule?.("node:crypto");
      if (!cryptoMod) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dynamicRequire = Function("m", "return require(m)") as any as (m: string) => unknown;
        cryptoMod = dynamicRequire("node:crypto");
      }
      if (cryptoMod?.createHash) {
        return cryptoMod.createHash("sha256").update(text).digest("hex") as string;
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** `"h:" + sha256(value)[:32]`, or undefined for an empty / non-string value. */
export function hashEndUser(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const hex = sha256HexNode(value);
  return hex === undefined ? undefined : `h:${hex.slice(0, 32)}`;
}

/** Set the active trace's `userId` from a provider end-user value (see file header). */
export function applyEndUser(raw: unknown): void {
  try {
    if (!isCaptureEndUser()) return;
    const state = getActiveTraceState();
    if (state === null || state.userId !== undefined) return;
    const hashed = hashEndUser(raw);
    if (hashed !== undefined) state.userId = hashed;
  } catch {
    // telemetry must never break the caller
  }
}
