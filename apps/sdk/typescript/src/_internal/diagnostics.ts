/**
 * SDK self-diagnostics — Morse-owned internal error reporting (MHQ-908).
 *
 * Mirrors the Python SDK's `_internal/diagnostics.py`. Replaces the Sentry
 * reporter: when the SDK absorbs an internal exception (per the non-invasive
 * guarantee in `_internal/errors.ts`), it reports to Morse's own
 * `/api/v1/diagnostics/sdk` rather than to a third party the customer may not
 * have installed.
 *
 * Two channels, both silent on a healthy install:
 *
 *   - **errors** — one absorbed exception with a *Morse-scoped* stack. Frames
 *     inside this package go in full; every run of frames outside it collapses
 *     to a count. No local variables, at any verbosity level.
 *   - **counters** (SDKDIAG-09) — aggregate `{reason, category, quantity}` for
 *     telemetry we discarded, adopted from Sentry's client reports, which is
 *     what that vendor chose to send *instead of* SDK stack traces.
 *
 * **Transport is deliberately its own** (founder decision, 2026-08-03, Option
 * B): a bounded buffer plus a timer, created on the FIRST report and never
 * before. Routing through the shared transport would have been a smaller diff,
 * but that queue is bounded and drops, so a diagnostic storm would evict the
 * customer's telemetry. Lazy creation matters more in JS than in Python: an
 * armed timer keeps the Node event loop alive, so a healthy process must not
 * arm one. The timer is `unref()`d where available for the same reason.
 *
 * **Nothing here is private from the host.** Everything transmitted is also
 * written to the console, rate-limited, whether or not transmission succeeds
 * and even when the customer has opted out entirely (SDKDIAG-10).
 *
 * **Never throws.** A failure anywhere is swallowed — never retried, never
 * reported about itself (SDKDIAG-06).
 */

import { getApiKey, getEndpoint, isDebug, isDisabled, isTelemetryDisabled } from "./env";
import { type RedactionConfig, SECRET_ASSIGNMENT_SOURCE, redactValue } from "./redaction";

// Build-time define, same as transport.ts. Declared rather than imported so
// this module stays a leaf — transport imports us for the drop counters, and a
// cycle here would be resolved at module-init time on the error path.
declare const __SDK_VERSION__: string | undefined;
const SDK_VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";

export const LEVEL_OFF = "off";
export const LEVEL_ERROR = "error";
export const LEVEL_DEBUG = "debug";
const VALID_LEVELS: ReadonlySet<string> = new Set([LEVEL_OFF, LEVEL_ERROR, LEVEL_DEBUG]);

/**
 * Learned from the `X-Morse-Diagnostics` response header on traffic the SDK is
 * already sending. `error` until a header says otherwise — matching the server
 * model's default, so behaviour before the first response matches after.
 */
let level: string = LEVEL_ERROR;

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 100;
/** `debug` relaxes the send budget; it never relaxes what may be sent. */
const RATE_LIMIT_PER_WINDOW_DEBUG = 1000;
const rateBuckets: Map<string, number[]> = new Map();

/**
 * Local emission is limited separately from transmission so our send budget is
 * never the host's visibility ceiling (SDKDIAG-10).
 */
const LOCAL_LOG_WINDOW_MS = 60_000;
export const LOCAL_LOG_LIMIT_PER_WINDOW = 10;
const localLogBuckets: Map<string, number[]> = new Map();

// Payload caps — mirror apps/api/apps/diagnostics/schemas.py.
export const MAX_STACK_ENTRIES = 64;
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_BATCH_EVENTS = 32;
const ALLOWED_EXTRA_KEYS: ReadonlySet<string> = new Set([
  "adapter",
  "module",
  "function",
  "operation",
  "endpoint_host",
]);

const DIAGNOSTICS_PATH = "/api/v1/diagnostics/sdk";
const MAX_PENDING = 100;
const FLUSH_INTERVAL_MS = 5000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 300_000;

// --- Delivery counters (SDKDIAG-09) ----------------------------------------

export const REASON_QUEUE_FULL = "queue_full";
/** Retryable failure, attempts made and used up (3, per MHQ-1001). */
export const REASON_RETRY_EXHAUSTED = "retry_exhausted";
export const REASON_QUOTA_REJECTED = "quota_rejected";
/** A genuine serialisation failure — JSON.stringify threw. */
export const REASON_ENCODE_FAILED = "encode_failed";
export const REASON_SHUTDOWN_DROP = "shutdown_drop";
/** 401/403 — key revoked, expired, or missing a scope. */
export const REASON_AUTH_REJECTED = "auth_rejected";
/** Other non-429 4xx — wrong URL, or a payload the server will never accept. */
export const REASON_ENDPOINT_REJECTED = "endpoint_rejected";
/** A send failed and the batch was dropped without further attempts. */
export const REASON_SEND_FAILED = "send_failed";
// No breaker-open reason: the customer-telemetry transport has no circuit
// breaker, and the breaker that does exist — this module's own — may not
// report on itself (SDKDIAG-06). A constant here would be unreachable by
// construction. See SDKDIAG-09.

/**
 * Plain-language cause for the local warning, so a wrong or revoked key reads as that and not as
 * an OpenTelemetry internal (offshore QA 2026-11-12). Unknown reasons keep the generic text.
 */
const REASON_HINTS: Record<string, string> = {
  [REASON_AUTH_REJECTED]:
    "Amund rejected your API key (wrong, revoked or expired); check AMUND_API_KEY (or MORSE_API_KEY)",
  [REASON_QUOTA_REJECTED]:
    "Amund is rate limiting or over quota for this key; telemetry is being lost",
  [REASON_ENDPOINT_REJECTED]: "Amund rejected the request; check the endpoint URL and SDK version",
  [REASON_RETRY_EXHAUSTED]:
    "could not reach the Amund API after retrying; check your network and endpoint",
  [REASON_SEND_FAILED]: "could not reach the Amund API; telemetry is being lost",
};

/**
 * What the transport knows about a drop beyond its reason code, so the local warning can name the
 * cause in plain words (offshore QA round 2, MHQ-1838). Optional: callers that know nothing more
 * get the generic hint above. Changes only the text of the warning — never counting or delivery.
 */
export interface DropDetail {
  /** HTTP status the server answered with (401/403 for a rejected key). */
  status?: number;
  /** Host the SDK was sending to, e.g. `api.amundai.com`. */
  host?: string;
  /** The send failed at the network layer (DNS, refused, reset, timeout), not with an HTTP answer. */
  unreachable?: boolean;
}

const NETWORK_ERROR_PATTERN =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|timed? ?out|timeout|aborted/i;

/**
 * True when `err` is a network-layer failure (DNS, connection refused or reset, timeout) rather
 * than an HTTP answer. Looks at `code`, `message` and one level of `cause` (undici's `fetch failed`
 * carries the real errno there). Never throws.
 */
export function isNetworkError(err: unknown): boolean {
  // forceFlush rejects with an array of the processors' errors (MHQ-1838).
  if (Array.isArray(err)) return err.length > 0 && err.every(isNetworkError);
  try {
    const seen = [err, (err as { cause?: unknown } | null | undefined)?.cause];
    for (const e of seen) {
      if (e == null) continue;
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string" && NETWORK_ERROR_PATTERN.test(code)) return true;
      const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
      if (message && NETWORK_ERROR_PATTERN.test(message)) return true;
    }
  } catch {
    // Classification is best-effort.
  }
  return false;
}

/** True when `err` carries an HTTP 401/403 as its `code` (the `OTLPExporterError` shape), or is an array of such errors. */
export function isAuthError(err: unknown): boolean {
  if (Array.isArray(err)) return err.length > 0 && err.every(isAuthError);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 401 || code === 403;
}

function plural(category: string): string {
  return `${category.charAt(0).toUpperCase()}${category.slice(1)}s`;
}

/** The one-line local warning for a drop. Exported for tests. */
export function dropWarning(
  reason: string,
  category: string,
  quantity: number,
  detail?: DropDetail,
): string {
  const count = `${quantity} ${category}(s)`;
  if (reason === REASON_AUTH_REJECTED) {
    const status = detail?.status ?? "401/403";
    return `morse: Amund rejected the API key (${status}): ${count} dropped. Check AMUND_API_KEY (or MORSE_API_KEY) or get a new key in Settings → API keys.`;
  }
  if (detail?.unreachable && (reason === REASON_RETRY_EXHAUSTED || reason === REASON_SEND_FAILED)) {
    const host = detail.host ?? "the Amund API";
    return `morse: Amund unreachable (${host}): ${count} dropped after retries. ${plural(category)} are not buffered across outages.`;
  }
  return `morse: dropped ${quantity} ${category} (${reason}) — ${REASON_HINTS[reason] ?? "telemetry is being lost"}`;
}

/* One "retrying" line per outage, so the wait before a drop is not silent. Reset by the next
 * successful send, so a later outage says so again. */
let retryingNoticeShown = false;

/** Say once per outage that the SDK is retrying. Text only; never throws. */
export function noteRetrying(host: string | undefined, notResponding = false): void {
  try {
    if (retryingNoticeShown) return;
    retryingNoticeShown = true;
    const where = host ?? "the Amund API";
    console.warn(
      notResponding
        ? `morse: Amund not responding (${where}), retrying…`
        : `morse: Amund unreachable (${where}), retrying…`,
    );
  } catch {
    // Never break a send.
  }
}

/** A send succeeded: the next outage gets its own "retrying" line. */
export function noteDelivered(): void {
  retryingNoticeShown = false;
}

interface CounterEntry {
  reason: string;
  category: string;
  quantity: number;
}

const counters: Map<string, CounterEntry> = new Map();

interface DiagnosticEvent {
  kind: "error" | "counters";
  fingerprint: string;
  error_type?: string;
  message?: string;
  stack?: Array<Record<string, unknown>>;
  counters?: CounterEntry[];
  sdk_language: string;
  sdk_version: string;
  runtime_version?: string;
  platform?: string;
  extra?: Record<string, string>;
}

/**
 * Active redaction config, PUSHED here by `tracing.setRedactionConfig`.
 *
 * Push rather than pull so this module imports nothing but `env` and
 * `redaction`. A static import of `tracing` would close a cycle
 * (transport → diagnostics → tracing → transport) that resolves at module-init
 * time, and the error path is the worst place to discover a half-initialised
 * module.
 */
let activeRedactionConfig: RedactionConfig | null = null;

export function setRedactionConfig(config: RedactionConfig | null): void {
  activeRedactionConfig = config;
}

let pending: DiagnosticEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;
/** Re-entrancy fence (SDKDIAG-06). */
let reporting = false;

export function setLevel(raw: string | null | undefined): void {
  if (!raw) return;
  const value = String(raw).trim().toLowerCase();
  // Unrecognised values are ignored rather than treated as `off` — a future
  // server value must not silently mute an old SDK.
  if (!VALID_LEVELS.has(value)) return;
  level = value;
}

export function getLevel(): string {
  return level;
}

/**
 * True when this process may put diagnostics on the wire. The customer's kill
 * switch beats every server-side setting — that ordering is the whole point of
 * having a client-side switch.
 */
export function transmissionAllowed(): boolean {
  if (isTelemetryDisabled() || isDisabled()) return false;
  return level !== LEVEL_OFF;
}

function checkBucket(
  buckets: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? [];
  const cutoff = now - windowMs;
  while (bucket.length > 0 && (bucket[0] as number) < cutoff) bucket.shift();
  if (bucket.length >= limit) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  buckets.set(key, bucket);
  return true;
}

export function checkRateLimit(fingerprint: string): boolean {
  const limit = level === LEVEL_DEBUG ? RATE_LIMIT_PER_WINDOW_DEBUG : RATE_LIMIT_PER_WINDOW;
  return checkBucket(rateBuckets, fingerprint, limit, RATE_WINDOW_MS);
}

// --- Morse-scoped stack (SDKDIAG-02) ---------------------------------------

/**
 * Frames mentioning this package are ours; everything else is the host's.
 *
 * Matching on the module path is a heuristic (a bundled build flattens paths),
 * and it fails CLOSED: an unrecognised frame is treated as the host's and
 * elided. Over-eliding costs us a debugging detail; under-eliding would ship
 * the customer's file layout.
 *
 * **Every package name the SDK code has ever shipped under must be listed.**
 * Since the Amund rebrand the package is published as `@amundai/sdk` (also the in-repo
 * workspace name), so customer installs live at `@amundai/sdk/...`. Older
 * installs live at `@morsehq-dev/sdk/...` (the pre-rebrand npm name, which
 * is now shipped only as a re-export shim) and older checkouts used the
 * workspace name `@morsehq/sdk`. `amund-sdk` / `morse-sdk` cover repo checkouts.

 * Listing only the in-repo name is what shipped through 0.5.0-rc.4: no frame
 * in any published build was recognised as ours, so every stack collapsed to
 * `[{elided: n}]` and diagnostics could not say where the SDK broke. Verified
 * against the published rc4 artifact on 2026-08-07.
 *
 * Matched as exact scoped-package substrings rather than a bare `morsehq`, to
 * keep the fail-closed property: a customer directory that merely contains our
 * name must not cause their frames to be transmitted in full.
 */
const MORSE_PATH_MARKERS = [
  "@amundai/sdk",
  "@morsehq/sdk",
  "@morsehq-dev/sdk",
  "amund-sdk",
  "morse-sdk",
  "/morse/",
  "morse_ai",
];

function isMorseFrame(line: string): boolean {
  return MORSE_PATH_MARKERS.some((marker) => line.includes(marker));
}

/** Parse `at fn (file:line:col)` into its parts, best-effort. */
function parseFrame(line: string): { file?: string; lineNo?: number; fn?: string } {
  const withParens = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/.exec(line);
  if (withParens) {
    return {
      fn: withParens[1],
      file: withParens[2],
      lineNo: Number(withParens[3]),
    };
  }
  const bare = /^\s*at\s+(.+?):(\d+):(\d+)\s*$/.exec(line);
  if (bare) return { file: bare[1], lineNo: Number(bare[2]) };
  return {};
}

export function buildScopedStack(error: unknown): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  try {
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    if (!stack) return frames;
    let elided = 0;
    for (const raw of stack.split("\n")) {
      if (!raw.trim().startsWith("at ")) continue; // the message line
      if (isMorseFrame(raw)) {
        if (elided > 0) {
          frames.push({ elided });
          elided = 0;
        }
        const { file, lineNo, fn } = parseFrame(raw);
        const frame: Record<string, unknown> = {};
        // Keep only the tail of the path: an absolute path leaks the host's
        // directory layout (usernames, deploy paths).
        if (file) frame.file = file.split(/[\\/]/).slice(-3).join("/");
        if (typeof lineNo === "number" && !Number.isNaN(lineNo)) frame.line = lineNo;
        if (fn) frame.function = fn.slice(0, 255);
        frames.push(frame);
      } else {
        elided += 1;
      }
    }
    if (elided > 0) frames.push({ elided });
  } catch {
    // A partial stack beats no diagnostic.
  }
  return frames.length > MAX_STACK_ENTRIES ? frames.slice(-MAX_STACK_ENTRIES) : frames;
}

/**
 * Exception message, redacted and capped.
 *
 * An exception message is not automatically safe — it can name a customer key
 * or echo content — so it goes through the same redaction the telemetry path
 * uses, and then through the secret-assignment pattern a second time,
 * unconditionally. A redactor fault returns a placeholder rather than the raw
 * string: failing closed is the only acceptable direction here.
 *
 * The second pass is the point (MHQ-973). `secret_assignment` is disableable,
 * because an org may legitimately want raw `password=` values in *their own*
 * spans. This channel is different: the published disclosure (SDKDIAG-02)
 * promises Morse receives no customer data, and that promise must not be
 * defeatable by someone's telemetry preference. Over-redacting our own error
 * text costs a little debuggability; under-redacting leaks a credential to us.
 */
function redactedMessage(error: unknown): string {
  let raw: string;
  try {
    raw = error instanceof Error ? error.message : String(error);
  } catch {
    return "";
  }
  try {
    if (activeRedactionConfig) {
      const out = redactValue(raw, activeRedactionConfig);
      raw = typeof out === "string" ? out : String(out);
    }
    // Fresh RegExp per call: a `g`-flagged instance carries `lastIndex`.
    raw = raw.replace(new RegExp(SECRET_ASSIGNMENT_SOURCE, "gi"), "[REDACTED:secret]");
  } catch {
    return "<redaction unavailable>";
  }
  return raw.slice(0, MAX_MESSAGE_CHARS);
}

export function scrubExtra(extra: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!extra) return out;
  for (const [key, value] of Object.entries(extra)) {
    if (ALLOWED_EXTRA_KEYS.has(key) && value != null) {
      out[key] = String(value).slice(0, 255);
    }
  }
  return out;
}

/**
 * Count telemetry we discarded. Never throws, never sends immediately.
 *
 * Delivery loss is what the customer's on-call most needs to know, so it is a
 * `console.warn` locally even though it is only a counter on the wire.
 */
export function recordDrop(
  reason: string,
  category: string,
  quantity = 1,
  detail?: DropDetail,
): void {
  try {
    if (quantity <= 0) return;
    const key = `${reason}:${category}`;
    const existing = counters.get(key);
    if (existing) existing.quantity += quantity;
    else counters.set(key, { reason, category, quantity });

    if (
      checkBucket(localLogBuckets, `drop:${key}`, LOCAL_LOG_LIMIT_PER_WINDOW, LOCAL_LOG_WINDOW_MS)
    ) {
      console.warn(dropWarning(reason, category, quantity, detail));
    }
    // MHQ-1030: arm the flush timer so the count goes out on the normal
    // cadence. Counters alone used to arm nothing, so a process that lost
    // telemetry but never threw reported it only at `shutdown()` — i.e. never,
    // for a long-lived server or one killed outright. The timer is `unref`'d,
    // so this still cannot hold the process open.
    if (transmissionAllowed()) ensureTimer();
  } catch {
    // Counter bookkeeping must never break a caller.
  }
}

/* MHQ-1787 (offshore QA round 1, finding 06): with no AMUND_API_KEY and no
 * `init()`, `morse.run()` still hands back a real-looking trace id (kept on
 * purpose, `traceId` semantics are unchanged) while nothing is ever sent. The
 * one-time "SDK calls are silent no-ops" warning at first use is easy to miss,
 * so count those runs and say so loudly, once, when the process exits. No
 * public attribute: the count lives here and only feeds the warning. */
let unsentNoKeyRuns = 0;
let unsentExitHookRegistered = false;

/** Count a run that cannot be sent because no API key is set. Never throws. */
export function recordUnsentRunNoKey(): void {
  try {
    unsentNoKeyRuns += 1;
    if (!unsentExitHookRegistered && typeof process !== "undefined" && process.once) {
      unsentExitHookRegistered = true;
      // "exit" (not "beforeExit") also fires on `process.exit()`; console.warn
      // is synchronous, which is all an exit handler may do.
      process.once("exit", warnUnsentRunsAtExit);
    }
  } catch {
    // Counter bookkeeping must never break a caller.
  }
}

/** Warn once that runs were not sent for lack of an API key. Never throws. */
export function warnUnsentRunsAtExit(): void {
  try {
    const count = unsentNoKeyRuns;
    unsentNoKeyRuns = 0;
    if (count > 0) {
      console.warn(
        `morse: ${count} run(s) not sent: no API key (set AMUND_API_KEY or call init(); MORSE_API_KEY still works)`,
      );
    }
  } catch {
    // Never break process exit.
  }
}

export function drainCounters(): CounterEntry[] {
  if (counters.size === 0) return [];
  const drained = [...counters.values()];
  counters.clear();
  return drained;
}

export interface ReportOptions {
  fingerprint: string;
  extra?: Record<string, unknown>;
  /**
   * Print the raw local line only under `AMUND_SDK_DEBUG=1`. For failures a plain drop warning
   * already explained (rejected key, unreachable endpoint), so the host is not shown an
   * OpenTelemetry internal on top of it (MHQ-1838). Transmission is unaffected.
   */
  localOnlyInDebug?: boolean;
}

/**
 * Report an absorbed internal SDK error. Never throws.
 *
 * Signature is unchanged from the Sentry reporter it replaces, so every
 * `absorbErrors` call site keeps working untouched.
 */
export function report(error: unknown, options: ReportOptions): void {
  if (reporting) return; // SDKDIAG-06
  reporting = true;
  try {
    const errClass = error instanceof Error ? error.name : "Error";
    const errMessage = error instanceof Error ? error.message : String(error);

    // SDKDIAG-10: local FIRST, gated only by its own limiter. Transmission may
    // be off, blocked, or failing — the host still sees it.
    if (
      (!options.localOnlyInDebug || isDebug()) &&
      checkBucket(
        localLogBuckets,
        options.fingerprint,
        LOCAL_LOG_LIMIT_PER_WINDOW,
        LOCAL_LOG_WINDOW_MS,
      )
    ) {
      const line = `morse internal error [${options.fingerprint}]: ${errClass}: ${errMessage}`;
      if (isDebug()) console.error(line, error);
      else console.warn(line);
    }

    if (!transmissionAllowed()) return;
    if (!checkRateLimit(options.fingerprint)) return;

    enqueue({
      kind: "error",
      fingerprint: options.fingerprint.slice(0, 255),
      error_type: errClass.slice(0, 255),
      message: redactedMessage(error),
      stack: buildScopedStack(error),
      sdk_language: "typescript",
      sdk_version: sdkVersion(),
      runtime_version: runtimeVersion(),
      platform: platformLabel(),
      extra: scrubExtra(options.extra),
    });
  } catch {
    // Absolute last-resort: nothing here may propagate.
  } finally {
    reporting = false;
  }
}

function sdkVersion(): string {
  return SDK_VERSION;
}

function runtimeVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (globalThis as any).process;
    return proc?.version ? String(proc.version) : "";
  } catch {
    return "";
  }
}

function platformLabel(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (globalThis as any).process;
    if (proc?.platform) return `${proc.platform}-${proc.arch ?? ""}`.slice(0, 128);
    return "browser";
  } catch {
    return "";
  }
}

function enqueue(event: DiagnosticEvent): void {
  // Oldest-first eviction: during an incident the newest diagnostics describe
  // what is happening now; a buffer of stale ones is worth less.
  pending.push(event);
  while (pending.length > MAX_PENDING) pending.shift();
  ensureTimer();
}

/**
 * Arm the flush timer on first use — never at import.
 *
 * Option B's lazy half, and it matters more here than in Python: an armed
 * `setInterval` keeps the Node event loop alive, so a healthy process that
 * armed one at import would refuse to exit. `unref()` where available means
 * even an armed timer never holds the process open.
 */
function ensureTimer(): void {
  if (timer !== null) return;
  try {
    timer = setInterval(() => {
      void flushOnce();
    }, FLUSH_INTERVAL_MS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (timer as any)?.unref?.();
  } catch {
    timer = null;
  }
}

function breakerBlocks(): boolean {
  return breakerOpenUntil > 0 && Date.now() < breakerOpenUntil;
}

function recordResult(ok: boolean): void {
  if (ok) {
    consecutiveFailures = 0;
    breakerOpenUntil = 0;
    return;
  }
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    // Open the breaker; when it lapses exactly one probe goes out (the counter
    // is not reset, so a failed probe re-opens it immediately).
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

export async function flushOnce(): Promise<void> {
  try {
    const batch = pending.splice(0, MAX_BATCH_EVENTS);
    const drained = drainCounters();
    if (drained.length > 0) {
      batch.push({
        kind: "counters",
        fingerprint: "morse.transport.delivery",
        counters: drained,
        sdk_language: "typescript",
        sdk_version: sdkVersion(),
      });
    }
    // SDKDIAG-01/09: a healthy interval transmits nothing.
    if (batch.length === 0) return;
    if (breakerBlocks() || !transmissionAllowed()) return;

    const target = resolveTarget();
    if (target === null) return;

    let response: Response;
    try {
      response = await fetch(target.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      // Network fault. No retry — a retry loop here would amplify exactly the
      // situation we are reporting about (SDKDIAG-06).
      recordResult(false);
      return;
    }
    setLevel(response.headers.get("X-Morse-Diagnostics"));
    recordResult(response.ok);
  } catch {
    // The flush loop must outlive any single batch.
  }
}

// MHQ-927: the live client's configuration, pushed in by `init()`.
//
// Python's `_resolve_target` reads `morse_ai._client` first and only falls
// back to the environment. TS read the environment ONLY, so a consumer who
// configured the SDK programmatically — `morse.init({ apiKey, endpoint })`,
// the idiomatic and documented form — had no resolvable target and every
// diagnostic was silently dropped. Traces still worked, because the transport
// gets its config from `init()` directly.
//
// Pushed rather than pulled, mirroring `setDiagnosticsRedactionConfig`, to
// keep diagnostics free of an import cycle back into `index.ts`.
let clientConfig: { apiKey?: string; endpoint?: string } | null = null;

export function setDiagnosticsClientConfig(
  config: { apiKey?: string; endpoint?: string } | null,
): void {
  clientConfig = config;
}

function resolveTarget(): { apiKey: string; url: string } | null {
  try {
    const apiKey = clientConfig?.apiKey || getApiKey();
    if (!apiKey) return null; // No authenticated destination — local-log-only.
    const url = deriveDiagnosticsUrl(String(clientConfig?.endpoint || getEndpoint() || ""));
    if (!url) return null;
    return { apiKey: String(apiKey), url };
  } catch {
    return null;
  }
}

export function deriveDiagnosticsUrl(tracesEndpoint: string): string | null {
  try {
    const parsed = new URL(tracesEndpoint);
    return `${parsed.protocol}//${parsed.host}${DIAGNOSTICS_PATH}`;
  } catch {
    return null;
  }
}

/**
 * Test-only reset hook.
 *
 * @internal
 */
export function _resetForTesting(): void {
  clientConfig = null;
  rateBuckets.clear();
  localLogBuckets.clear();
  counters.clear();
  unsentNoKeyRuns = 0;
  retryingNoticeShown = false;
  pending = [];
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
  reporting = false;
  level = LEVEL_ERROR;
  activeRedactionConfig = null;
}

/**
 * True when the flush timer is armed. Exported so tests can assert the
 * central Option B claim: a healthy process arms nothing.
 *
 * @internal
 */
export function _hasTimer(): boolean {
  return timer !== null;
}
