/**
 * Environment variable resolution for SDK auto-init.
 *
 * The V2 TS SDK supports zero-setup integration: the customer sets
 * `AMUND_API_KEY` in their process environment (Node) or supplies
 * it via build-time replacement (browser bundler), and the SDK
 * auto-initializes on first use. This module centralises the env-var
 * contract so the rules stay in one place.
 *
 * Naming (Amund rebrand): every variable is read as `AMUND_<NAME>`
 * first and falls back to the pre-rebrand `MORSE_<NAME>`, so existing
 * deployments keep working unchanged. `AMUND_<NAME>` wins when both are set to
 * a non-empty value; an empty or whitespace-only `AMUND_<NAME>` counts as
 * unset and falls through to `MORSE_<NAME>`. Every reader in the SDK goes
 * through `readSdkEnv()` / `readSdkEnvFrom()` / `sdkEnvNames()` below.
 *
 * Env vars (all optional unless noted; each also accepted as `MORSE_<NAME>`)
 * — must mirror the Python SDK's `_internal/env.py`:
 *
 * - `AMUND_API_KEY`              — triggers auto-init when set; absent = SDK dormant
 * - `AMUND_ENDPOINT`             — override default ingestion URL
 * - `AMUND_FLUSH_INTERVAL_SECONDS` — override default 2.0s flush interval
 * - `AMUND_DISABLED`             — "1"/"true" makes all SDK calls no-op
 * - `AMUND_SDK_DEBUG`            — "1"/"true" raises internal-error log level
 * - `AMUND_SDK_DISABLE_TELEMETRY` — "1"/"true" suppresses out-of-band SDK
 *   self-diagnostics (errors + delivery counters). Local logging is
 *   unaffected — see SDKDIAG-10.
 * - `AMUND_DISABLE_AUTO_DETECT`   — (MHQ-482, mirrors Python's `*_DISABLE_AUTO_DETECT`)
 *                                    "1"/"true" skips the zero-config adapter auto-detect scan
 * - `AMUND_SAMPLE_RATE`           — (MHQ-482, mirrors Python MHQ-668/671) deterministic
 *                                    trace-ID head sampling rate in [0.0, 1.0], default 1.0.
 * - `AMUND_MAX_FIELD_BYTES`       — (MHQ-482) byte cap applied to input_data / output_data /
 *                                    context_segments / custom metadata at attribute-set
 *                                    time, default 65536.
 * - `AMUND_MAX_QUEUE_SIZE`        — (MHQ-482) OTel BatchSpanProcessor queue size, default
 *                                    2048 (OTel SDK default).
 * - `AMUND_MAX_BATCH_SIZE`        — (MHQ-482) OTel BatchSpanProcessor max export batch
 *                                    size, default 512 (OTel SDK default).
 * - `AMUND_LEGACY_TRANSPORT`      — (MHQ-482) "1"/"true" reverts run()/span()/runTraced()
 *                                    to the pre-OTel JSON batch transport instead of OTLP.
 *                                    Escape hatch for the migration window only;
 *                                    record()/log() always use the JSON path.
 * - `AMUND_CAPTURE_DB` / `AMUND_CAPTURE_HTTP` / `AMUND_CAPTURE_QUEUE` — (INFRACAP-01/02)
 *                                    zero-config `db` / `http` / queue span capture is ON
 *                                    by default since 0.7.0, inside an active trace only.
 *                                    "0"/"false"/"no"/"off" opts out of that one capture.
 * - `AMUND_CAPTURE_INFRA`         — "0"/"false" opts out of all three at once; a specific
 *                                    flag above still wins.
 * - `AMUND_CAPTURE_HTTP_EXCLUDE_HOSTS` — comma-separated extra hosts HTTP capture skips.
 * - `AMUND_CAPTURE_QUEUE_CONSUMER` — "1"/"true" opts in to consumer-side trace continuation.
 * - `AMUND_INTERNAL_SOURCE`       — dogfood-only source label (whitelisted values).
 * - `AMUND_PROPAGATE_TRACE_CONTEXT` — read in `propagation.ts`.
 * - `AMUND_AGENT_IDENTITY`        — read in `agent-name.ts`.
 * - `AMUND_GIT_REVISION`          — read in `revision.ts`.
 */

/** Prefix read first for every SDK env var (post-rebrand name). */
export const ENV_PREFIX = "AMUND_";
/** Pre-rebrand prefix, still honoured as a fallback. */
export const LEGACY_ENV_PREFIX = "MORSE_";

/**
 * The env var names consulted for `name` (e.g. `"API_KEY"`), in precedence
 * order: `["AMUND_API_KEY", "MORSE_API_KEY"]`.
 */
export function sdkEnvNames(name: string): [string, string] {
  return [ENV_PREFIX + name, LEGACY_ENV_PREFIX + name];
}

/**
 * Production API host. `api.amundai.com` is the default since 0.8.1;
 * `api.morseai.dev` (the default from 0.7.2 to 0.8.0) is a permanent alias for the
 * same service, so an `AMUND_ENDPOINT` / `MORSE_ENDPOINT` pinned to it keeps working.
 */
export const DEFAULT_API_HOST = "api.amundai.com";

/**
 * Every host that serves the production API. Used where the SDK has to
 * recognise its own backend (HTTP auto-capture never traces the SDK's own POSTs).
 */
export const PROD_API_HOSTS: readonly string[] = ["api.amundai.com", "api.morseai.dev"];

/**
 * Default ingestion endpoint. Mirrors the Python SDK constant in
 * `morse_ai/_internal/env.py`.
 */
export const DEFAULT_ENDPOINT = `https://${DEFAULT_API_HOST}/api/v1/traces/batch`;

/**
 * Read one raw env var in a runtime-agnostic way.
 *
 * Handles Node (`process.env`), Deno (`Deno.env`), and browser
 * environments where `process` is undefined. In the browser the value
 * typically comes from a bundler-time replacement (Next.js inlines
 * `process.env.AMUND_API_KEY` at build time when the var is
 * exposed via `next.config.ts`).
 */
function readRawEnv(key: string): string | undefined {
  // Node / Next.js (server / build-time replaced)
  try {
    if (typeof process !== "undefined" && process.env) {
      const v = process.env[key];
      if (typeof v === "string") return v;
    }
  } catch {
    // Some sandboxes make `process.env` access throw — fall through.
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

function nonBlank(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Read SDK env var `name` (unprefixed, e.g. `"API_KEY"`): `AMUND_<name>` if it
 * is set to a non-blank value, else `MORSE_<name>` (returned as-is, including
 * an empty string). The single place the AMUND-over-MORSE precedence lives.
 */
export function readSdkEnv(name: string): string | undefined {
  const [current, legacy] = sdkEnvNames(name);
  return nonBlank(readRawEnv(current)) ?? readRawEnv(legacy);
}

/**
 * Same precedence as `readSdkEnv`, against an explicit env object (for
 * callers that take an injectable `env` for testing).
 */
export function readSdkEnvFrom(
  env: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!env) return undefined;
  const [current, legacy] = sdkEnvNames(name);
  const a = env[current];
  if (nonBlank(a) !== undefined) return a;
  const b = env[legacy];
  return typeof b === "string" ? b : undefined;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function getApiKey(): string | undefined {
  const raw = readSdkEnv("API_KEY");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function getEndpoint(): string | undefined {
  const raw = readSdkEnv("ENDPOINT");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function getFlushIntervalSeconds(defaultSeconds = 2.0): number {
  const raw = readSdkEnv("FLUSH_INTERVAL_SECONDS");
  if (!raw) return defaultSeconds;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultSeconds;
  return parsed;
}

export function isDisabled(): boolean {
  return truthy(readSdkEnv("DISABLED"));
}

export function isDebug(): boolean {
  return truthy(readSdkEnv("SDK_DEBUG"));
}

export function isTelemetryDisabled(): boolean {
  return truthy(readSdkEnv("SDK_DISABLE_TELEMETRY"));
}

/**
 * True when `AMUND_DISABLE_AUTO_DETECT=1` (or `MORSE_DISABLE_AUTO_DETECT=1`) — the zero-config adapter scan
 * (`_internal/auto-detect.ts`) is skipped entirely. Mirrors the Python SDK's
 * `is_auto_detect_disabled()`. Customers can still call the adapter
 * `wrapX()` / `instrumentX()` functions directly.
 */
export function isAutoDetectDisabled(): boolean {
  return truthy(readSdkEnv("DISABLE_AUTO_DETECT"));
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
  const raw = readSdkEnv("INTERNAL_SOURCE");
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
  const raw = readSdkEnv("SAMPLE_RATE");
  if (!raw) return defaultRate;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0.0 || parsed > 1.0) return defaultRate;
  return parsed;
}

/** Byte cap for input_data/output_data/context_segments/metadata attribute values. */
export function getMaxFieldBytes(defaultBytes = 65536): number {
  const raw = readSdkEnv("MAX_FIELD_BYTES");
  if (!raw) return defaultBytes;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultBytes;
}

/** OTel BatchSpanProcessor queue size (OTel SDK default: 2048). */
export function getMaxQueueSize(defaultSize = 2048): number {
  const raw = readSdkEnv("MAX_QUEUE_SIZE");
  if (!raw) return defaultSize;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSize;
}

/** OTel BatchSpanProcessor max export batch size (OTel SDK default: 512). */
export function getMaxBatchSize(defaultSize = 512): number {
  const raw = readSdkEnv("MAX_BATCH_SIZE");
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
  return truthy(readSdkEnv("LEGACY_TRANSPORT"));
}

const FALSY = ["0", "false", "no", "off"];

/** true / false for a recognised value, undefined for unset, empty or garbage. */
function flag(name: string): boolean | undefined {
  const raw = readSdkEnv(name)?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (FALSY.includes(raw)) return false;
  return undefined;
}

/** Unprefixed capture flag names; read as `AMUND_<flag>`, falling back to `MORSE_<flag>`. */
export type CaptureFlag = "CAPTURE_DB" | "CAPTURE_HTTP" | "CAPTURE_QUEUE";

/**
 * Default-on infra capture (INFRACAP-01/02, mirrors Python's
 * `infra_capture.py::capture_enabled`). A specific flag wins over
 * `AMUND_CAPTURE_INFRA`; with neither set, capture is ON. Capture only ever
 * records inside an active Morse trace.
 */
export function isCaptureEnabled(specific: CaptureFlag): boolean {
  const v = flag(specific) ?? flag("CAPTURE_INFRA");
  return v ?? true;
}

/** DB auto-capture switch. Default ON since 0.7.0; `AMUND_CAPTURE_DB=0` opts out. */
export function isDbCaptureEnabled(): boolean {
  return isCaptureEnabled("CAPTURE_DB");
}

/**
 * Queue consumer-side trace continuation (INFRACAP-08). Opt-in: needs an
 * explicit truthy `AMUND_CAPTURE_QUEUE_CONSUMER`.
 */
export function isQueueConsumerEnabled(): boolean {
  return truthy(readSdkEnv("CAPTURE_QUEUE_CONSUMER"));
}

/** Extra hosts to leave out of HTTP capture (`AMUND_CAPTURE_HTTP_EXCLUDE_HOSTS=a.com,b.com`). */
export function getHttpExcludeHosts(): string[] {
  const raw = readSdkEnv("CAPTURE_HTTP_EXCLUDE_HOSTS");
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/*
 * Every Morse key is `mhq_` + optional segments (`prod_`, `pk_dev_`, …) + 64
 * hex characters (apps/api `api_keys/models.py::generate_key`). A cheap local
 * shape check, so a truncated or mis-pasted key is named at init instead of
 * only as a 401 at the first flush (offshore QA round 2, MHQ-1838). Warning
 * only: no network call, the key is still used exactly as given.
 */
const API_KEY_SHAPE = /^mhq_(?:[A-Za-z0-9-]+_)*[0-9a-fA-F]{64}$/;

/** Why `apiKey` does not look like a Morse key, or `null` if it does. Never echoes the key. */
export function apiKeyShapeProblem(apiKey: string): string | null {
  if (API_KEY_SHAPE.test(apiKey)) return null;
  if (/^["']|["']$/.test(apiKey)) return "it is wrapped in quotes";
  if (apiKey.trim() !== apiKey) return "it has leading or trailing spaces";
  if (!apiKey.startsWith("mhq_")) return "it does not start with mhq_";
  return "it looks truncated or mistyped";
}
