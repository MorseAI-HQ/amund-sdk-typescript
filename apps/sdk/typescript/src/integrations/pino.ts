/**
 * Phase 12.5 Tier 1.2 stretch — minimal pino transport for Morse.
 *
 * Forwards pino log records through `morse.log()`, which batches
 * them onto the existing telemetry transport and ships them to the
 * dashboard's Logs tab — correlated to the active trace via the SDK's
 * `AsyncLocalStorage` context.
 *
 * # Usage (destination stream — works on pino v6 and v7+)
 *
 * ```ts
 * import pino from "pino";
 * import { morsePinoDestination } from "@morsehq-dev/sdk/integrations/pino";
 *
 * const logger = pino(
 *   { level: "info" },
 *   pino.multistream([
 *     { stream: process.stdout },
 *     { stream: morsePinoDestination() },
 *   ]),
 * );
 *
 * logger.info({ user_id: 42 }, "search complete");
 * ```
 *
 * # Why a destination, not a `pino.transport()` worker
 *
 * The Worker-thread transport API (`pino.transport({ target })`) requires
 * a separately-published npm module so pino can `require()` it inside the
 * worker. That cost (separate package, separate publish) is not warranted
 * for v1 — a destination stream covers ~95% of integrations and stays in
 * the same package. Customers who need a Worker transport can wrap this
 * destination in a thin module file and pass `target: "./that-file.js"`
 * themselves; see the README for the recipe.
 *
 * # Scope (v1)
 *
 * - Severity translation: pino numeric levels → Morse severity strings.
 * - Field extraction: `msg` → body, all other fields → attributes
 *   (less the pino-internal `level`, `time`, `pid`, `hostname`, `v`).
 * - NO winston transport in this commit — Phase 12.5 plan defers it.
 */

import { Writable } from "node:stream";

import { log, type LogSeverity } from "../log";

/**
 * Map pino numeric levels (10..60) to Morse severity strings.
 * Mirrors the pino docs convention:
 *   10 trace | 20 debug | 30 info | 40 warn | 50 error | 60 fatal
 */
function pinoLevelToSeverity(level: number | string | undefined): LogSeverity {
  const n = typeof level === "string" ? Number.parseInt(level, 10) : (level ?? 30);
  if (!Number.isFinite(n)) return "info";
  if (n >= 60) return "fatal";
  if (n >= 50) return "error";
  if (n >= 40) return "warn";
  if (n >= 30) return "info";
  if (n >= 20) return "debug";
  return "trace";
}

// Fields pino injects that we don't want to forward as user attributes —
// they're either redundant with what we already capture or pino-internal
// bookkeeping.
const PINO_INTERNAL_FIELDS: ReadonlySet<string> = new Set([
  "level",
  "time",
  "v",
  "msg",
  "pid",
  "hostname",
]);

function pickAttributes(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (PINO_INTERNAL_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Forward one parsed pino record through `morse.log()`. Exported
 * for callers building their own destination wrappers (e.g., the Worker
 * transport recipe). Customer code should usually wire
 * `morsePinoDestination()` instead.
 *
 * @internal but exported for advanced use
 */
export function forwardPinoRecord(record: Record<string, unknown>): void {
  const severity = pinoLevelToSeverity(record.level as number | string | undefined);
  const msg = typeof record.msg === "string" ? record.msg : "";
  const serviceName =
    typeof record.name === "string" && record.name.length > 0 ? record.name : undefined;
  const attributes = pickAttributes(record);
  log(msg, {
    severity,
    attributes,
    ...(serviceName ? { serviceName } : {}),
  });
}

/**
 * Construct a pino-compatible destination stream that forwards each
 * record through `morse.log()`.
 *
 * Pino writes one NDJSON object per write. Defensive: malformed JSON
 * is silently dropped (we never throw from the customer's logger
 * pipeline — same non-invasive guarantee the rest of the SDK provides).
 */
export function morsePinoDestination(): Writable {
  let buffer = "";

  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            forwardPinoRecord(record);
          } catch {
            // Malformed line — drop it silently. log() itself is
            // wrapped in `absorbErrors`, so any downstream failure is
            // also caught.
          }
        }
        callback();
      } catch (err) {
        // Final defensive net: never break the host's logging chain.
        callback(err as Error | null);
      }
    },
    // Flush whatever's left in the buffer when pino closes the stream.
    final(callback) {
      try {
        if (buffer.trim()) {
          try {
            const record = JSON.parse(buffer) as Record<string, unknown>;
            forwardPinoRecord(record);
          } catch {
            /* drop */
          }
        }
        buffer = "";
        callback();
      } catch (err) {
        callback(err as Error | null);
      }
    },
  });
}
