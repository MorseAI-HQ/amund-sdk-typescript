/**
 * Environment variable resolution for SDK auto-init.
 *
 * The V2 TS SDK supports zero-setup integration: the customer sets
 * `MORSE_API_KEY` in their process environment (Node) or supplies
 * it via build-time replacement (browser bundler), and the SDK
 * auto-initializes on first use. This module centralises the env-var
 * contract so the rules stay in one place.
 *
 * Env vars (all optional unless noted) — must mirror the Python SDK's
 * `_internal/env.py`:
 *
 * - `MORSE_API_KEY`              — triggers auto-init when set; absent = SDK dormant
 * - `MORSE_ENDPOINT`             — override default ingestion URL
 * - `MORSE_FLUSH_INTERVAL_SECONDS` — override default 2.0s flush interval
 * - `MORSE_DISABLED`             — "1"/"true" makes all SDK calls no-op
 * - `MORSE_SDK_DEBUG`            — "1"/"true" raises internal-error log level
 * - `MORSE_SDK_DISABLE_TELEMETRY` — "1"/"true" suppresses out-of-band SDK
 *   self-diagnostics (errors + delivery counters). Local logging is
 *   unaffected — see SDKDIAG-10.
 * - `MORSE_DISABLE_AUTO_DETECT`   — (MHQ-482, mirrors Python's `MORSE_DISABLE_AUTO_DETECT`)
 *                                    "1"/"true" skips the zero-config adapter auto-detect scan
 * - `MORSE_SAMPLE_RATE`           — (MHQ-482, mirrors Python MHQ-668/671) deterministic
 *                                    trace-ID head sampling rate in [0.0, 1.0], default 1.0.
 * - `MORSE_MAX_FIELD_BYTES`       — (MHQ-482) byte cap applied to input_data / output_data /
 *                                    context_segments / custom metadata at attribute-set
 *                                    time, default 65536.
 * - `MORSE_MAX_QUEUE_SIZE`        — (MHQ-482) OTel BatchSpanProcessor queue size, default
 *                                    2048 (OTel SDK default).
 * - `MORSE_MAX_BATCH_SIZE`        — (MHQ-482) OTel BatchSpanProcessor max export batch
 *                                    size, default 512 (OTel SDK default).
 * - `MORSE_LEGACY_TRANSPORT`      — (MHQ-482) "1"/"true" reverts run()/span()/runTraced()
 *                                    to the pre-OTel JSON batch transport instead of OTLP.
 *                                    Escape hatch for the migration window only;
 *                                    record()/log() always use the JSON path.
 * - `MORSE_CAPTURE_DB`            — (MHQ-482, mirrors Python's `infra_capture.py`)
 *                                    "1"/"true" enables zero-config `db` span
 *                                    auto-capture (pg / mysql2 / better-sqlite3).
 *                                    Opt-in, same as the Python SDK.
 * - `MORSE_CAPTURE_INFRA`         — (MHQ-482) "1"/"true" convenience alias that enables
 *                                    ALL infra auto-capture (currently just DB — mirrors
 *                                    Python's combined flag; HTTP capture is a separate
 *                                    port not yet landed in the TS SDK).
 */

/**
 * Default ingestion endpoint.
 *
 * Phase 6c targets the Railway dev URL until the custom domain is wired up
 * in Phase 6d. Mirrors the Python SDK constant in
 * `apps/sdk/python/src/morse/client.py`.
 */
export const DEFAULT_ENDPOINT = "https://api.morsehq.dev/api/v1/traces/batch";

/**
 * Read an env var in a runtime-agnostic way.
 *
 * Handles Node (`process.env`), Deno (`Deno.env`), and browser
 * environments where `process` is undefined. In the browser the value
 * typically comes from a bundler-time replacement (Next.js inlines
 * `process.env.MORSE_API_KEY` at build time when the var is
 * exposed via `next.config.ts`).
 */
function readEnv(key: string): string | undefined {
  // Node / Next.js (server / build-time replaced)
  if (typeof process !== "undefined" && process.env) {
    const v = process.env[key];
    if (typeof v === "string") return v;
  }
  // Deno
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const denoGlobal = (globalThis as any).Deno as
    | { env: { get(k: string): string | undefined } }
    | undefined;
  if (denoGlobal?.env?.get) {
    try {
      const v = denoGlobal.env.get(key);
      if (typeof v === "string") return v;
    } catch {
      // Permission denied — fall through.
    }
  }
  return undefined;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function getApiKey(): string | undefined {
  const raw = readEnv("MORSE_API_KEY");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function getEndpoint(): string | undefined {
  const raw = readEnv("MORSE_ENDPOINT");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function getFlushIntervalSeconds(defaultSeconds = 2.0): number {
  const raw = readEnv("MORSE_FLUSH_INTERVAL_SECONDS");
  if (!raw) return defaultSeconds;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultSeconds;
  return parsed;
}

export function isDisabled(): boolean {
  return truthy(readEnv("MORSE_DISABLED"));
}

export function isDebug(): boolean {
  return truthy(readEnv("MORSE_SDK_DEBUG"));
}

export function isTelemetryDisabled(): boolean {
  return truthy(readEnv("MORSE_SDK_DISABLE_TELEMETRY"));
}

/**
 * True when `MORSE_DISABLE_AUTO_DETECT=1` — the zero-config adapter scan
 * (`_internal/auto-detect.ts`) is skipped entirely. Mirrors the Python SDK's
 * `is_auto_detect_disabled()`. Customers can still call the adapter
 * `wrapX()` / `instrumentX()` functions directly.
 */
export function isAutoDetectDisabled(): boolean {
  return truthy(readEnv("MORSE_DISABLE_AUTO_DETECT"));
}

/**
 * Resource-level "source" label for Morse's own dogfood emitters.
 *
 * Mirrors the Python SDK's `get_internal_source()` (PR #90). Only the
 * accepted whitelist values are honoured — any other value is treated
 * as unset so a typo in a customer's environment never accidentally
 * tags their data as internal.
 */
const VALID_INTERNAL_SOURCES = new Set(["copilot", "investigator", "refagent", "ui-bot"]);

export function getInternalSource(): string | undefined {
  const raw = readEnv("MORSE_INTERNAL_SOURCE");
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  return VALID_INTERNAL_SOURCES.has(trimmed) ? trimmed : undefined;
}

export function isValidInternalSource(value: string | null | undefined): boolean {
  return typeof value === "string" && VALID_INTERNAL_SOURCES.has(value);
}

/**
 * Deterministic trace-ID head sampling rate for the OTel export pipeline
 * (MHQ-482, mirrors Python `_internal/env.py::get_sample_rate`). Out-of-range
 * or unparseable values fall back to `default`.
 */
export function getSampleRate(defaultRate = 1.0): number {
  const raw = readEnv("MORSE_SAMPLE_RATE");
  if (!raw) return defaultRate;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0.0 || parsed > 1.0) return defaultRate;
  return parsed;
}

/** Byte cap for input_data/output_data/context_segments/metadata attribute values. */
export function getMaxFieldBytes(defaultBytes = 65536): number {
  const raw = readEnv("MORSE_MAX_FIELD_BYTES");
  if (!raw) return defaultBytes;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultBytes;
}

/** OTel BatchSpanProcessor queue size (OTel SDK default: 2048). */
export function getMaxQueueSize(defaultSize = 2048): number {
  const raw = readEnv("MORSE_MAX_QUEUE_SIZE");
  if (!raw) return defaultSize;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSize;
}

/** OTel BatchSpanProcessor max export batch size (OTel SDK default: 512). */
export function getMaxBatchSize(defaultSize = 512): number {
  const raw = readEnv("MORSE_MAX_BATCH_SIZE");
  if (!raw) return defaultSize;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSize;
}

/**
 * Escape hatch: `run()`/`span()`/`runTraced()` revert to the pre-OTel JSON
 * batch transport instead of OTLP when set. `record()`/`log()` always use
 * the JSON path regardless of this flag.
 */
export function isLegacyTransport(): boolean {
  return truthy(readEnv("MORSE_LEGACY_TRANSPORT"));
}

/**
 * DB auto-capture opt-in (MHQ-482, mirrors Python's `infra_capture.py`'s
 * `MORSE_CAPTURE_DB` / `MORSE_CAPTURE_INFRA` env flags — see
 * `maybe_enable_from_env`). Opt-in while the approach is proven across
 * drivers, same posture as the Python SDK.
 */
export function isDbCaptureEnabled(): boolean {
  return truthy(readEnv("MORSE_CAPTURE_DB")) || truthy(readEnv("MORSE_CAPTURE_INFRA"));
}
