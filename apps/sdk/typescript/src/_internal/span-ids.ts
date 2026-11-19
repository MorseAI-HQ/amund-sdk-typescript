/**
 * Morse span id -> OTel / W3C 64-bit span id (MHQ-1880).
 *
 * Morse mints 128-bit hex `span_id` values; OTLP and a W3C `traceparent`
 * carry 64-bit ids. The mapping is deterministic so the id placed in an
 * outgoing `traceparent` header (before the span exists) equals the id the
 * OTLP export later gives the same span: both sides call `otelSpanIdFor`.
 * Same rule as the Python SDK's `_internal/span_ids.py`.
 *
 * Browser-safe: no OTel imports, so `propagation.ts` can use it everywhere.
 */

const HEX16 = /^[0-9a-f]{16}$/;
const ZERO_ID = "0000000000000001";

/** First 16 hex chars when they are valid and non-zero, else a hash of the whole id. */
export function otelSpanIdFor(spanId: string): string {
  const head = spanId.slice(0, 16).toLowerCase();
  if (HEX16.test(head) && !/^0+$/.test(head)) return head;
  const digest = hashHex16(spanId);
  return /^0+$/.test(digest) ? ZERO_ID : digest;
}

/**
 * First 16 hex of sha256(utf-8) under Node (identical to the Python SDK).
 * Browser bundles have no sync sha256 and export over the JSON transport, not
 * OTLP; they use FNV-1a. The SDK only mints hex ids, so this branch is a
 * safety net for ids a caller supplied.
 */
function hashHex16(text: string): string {
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicRequire = Function("m", "return require(m)") as any as (m: string) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cryptoMod = dynamicRequire("node:crypto") as any;
      if (cryptoMod?.createHash) {
        return (cryptoMod.createHash("sha256").update(text).digest("hex") as string).slice(0, 16);
      }
    }
  } catch {
    // fall through
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
