/**
 * DB auto-capture (MHQ-482) — TypeScript SDK parity port of the Python
 * SDK's `infra_capture.py` `db` span coverage.
 *
 * NOT a straight port. Python hand-patches PEP-249 driver methods
 * (`sqlite3.connect`, `psycopg2.connect`) because there's no other way to
 * intercept a C-extension cursor type. Node has no PEP-249 equivalent, and
 * — per the founder's standing decision on this gap — no reason to
 * hand-roll driver patching when OpenTelemetry's own community
 * instrumentation packages already do it, robustly, for the two most
 * common Node SQL drivers:
 *
 *   - `pg`      -> `@opentelemetry/instrumentation-pg`      (verified on
 *                   npm: real package, current version 0.73.0)
 *   - `mysql2`  -> `@opentelemetry/instrumentation-mysql2`  (verified on
 *                   npm: real package, current version 0.67.0)
 *   - `better-sqlite3` -> NO community package exists (verified: neither
 *                   `@opentelemetry/instrumentation-better-sqlite3` nor
 *                   `@opentelemetry/instrumentation-sqlite3` are published,
 *                   and the OTel JS contrib repo's instrumentation list has
 *                   no sqlite entry at all). `./db-capture-sqlite.ts` is a
 *                   small hand-rolled instrumentation following the exact
 *                   same `InstrumentationNodeModuleDefinition` hook pattern
 *                   the community packages use, so it degrades identically
 *                   (silent no-op) when `better-sqlite3` isn't installed.
 *
 * Attribute shape — no translation layer needed
 * ----------------------------------------------
 * Unlike `otel-provider.ts::emitTraceEntry` (which translates Morse's own
 * `SpanData` dicts into `morse.*`/`gen_ai.*`-namespaced OTel attributes because
 * THAT data has no OTel-native shape), these instrumentation packages
 * build real OTel spans directly and already emit the current stable OTel
 * semantic-convention DB attributes — `db.system.name`, `db.namespace`,
 * `db.query.text` (confirmed by reading `@opentelemetry/instrumentation-pg`
 * 0.73.0's `utils.js` / `semconv.js`). These are the same key names
 * `./db-capture-sqlite.ts`'s custom sqlite instrumentation uses, and are
 * standard, documented OTel semconv — the backend's generic OTLP ingestion
 * path (out of this gap's scope — owned by `apps/api/`) is the right place
 * for any further server-side mapping, not this SDK. No `spanDictToOtelAttributes`-
 * style translation is added here.
 *
 * Registration, not patching
 * ---------------------------
 * `registerDbInstrumentation()` builds instrumentation instances and hands
 * them to `otel-provider.ts::OtelEngine.registerInstrumentations()`, which
 * wires them to the SAME `NodeTracerProvider` (and therefore the same
 * `BatchSpanProcessor` -> `RedactingSpanExporter` -> `OTLPTraceExporter`
 * pipeline) the rest of the SDK's spans flow through — see that module's
 * docstring. Each instrumentation package internally uses
 * `require-in-the-middle` hooks (`InstrumentationNodeModuleDefinition`), so
 * constructing/registering them is always safe even when the target driver
 * isn't installed in the host app: the hook simply never fires.
 *
 * Correlation with `morse.span()` / `morse.run()`
 * -------------------------------------------------
 * These instrumentations read OTel's GLOBAL `context.active()` to find
 * their parent span. `tracing.ts`'s `runSync`/`runAsync`/`spanSync`/
 * `spanAsync` now set that global active context to a synthetic
 * `SpanContext` carrying the current Morse trace id + span id for the
 * duration of the wrapped callback (see `otel-provider.ts::withOtelSpanContext`)
 * — so a query made inside a `morse.span()` block nests under it via the
 * normal OTel parent/child mechanism, the same way it would in any other
 * OTel-instrumented Node app.
 *
 * Default-on since 0.7.0 (INFRACAP-01); `MORSE_CAPTURE_DB=0` /
 * `MORSE_CAPTURE_INFRA=0` opt out, mirroring Python's
 * `infra_capture.py::maybe_enable_from_env`. Nothing is recorded outside an
 * active Morse trace, and a trace keeps at most 200 db spans (INFRACAP-03/04).
 * Inline SQL literals are scrubbed at export (INFRACAP-05).
 */

import type { Instrumentation } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";

import { isDbCaptureEnabled } from "./env";
import { gateTracerProvider } from "./infra-shared";
import { getEngine } from "./otel-provider";
import { BetterSqlite3Instrumentation } from "./db-capture-sqlite";

let unregister: (() => void) | null = null;
let registeredInstrumentations: Instrumentation[] | null = null;

/**
 * Build one instance of each supported driver's `Instrumentation`. Exposed
 * separately from `registerDbInstrumentation()` so tests can construct them
 * without touching the module-level registration state.
 */
export function buildDbInstrumentations(): Instrumentation[] {
  return [
    new PgInstrumentation() as unknown as Instrumentation,
    new MySQL2Instrumentation() as unknown as Instrumentation,
    new BetterSqlite3Instrumentation() as unknown as Instrumentation,
  ];
}

/**
 * Register DB auto-capture against the engine's `NodeTracerProvider`.
 * Idempotent — calling this again first unregisters the previous set (same
 * "re-init replaces" contract `index.ts::init()` uses for the rest of the
 * singleton). No-op (returns `false`) if the OTel engine hasn't been
 * `configure()`-d yet — callers MUST invoke this after
 * `getOtelEngine().configure()` (see `index.ts::buildSingleton`).
 *
 * Never throws — construction/registration errors are swallowed, mirroring
 * the rest of this SDK's non-invasive guarantee (a driver-instrumentation
 * bug must never break the host app's DB calls).
 */
export function registerDbInstrumentation(): boolean {
  disableDbCapture();
  try {
    const instrumentations = buildDbInstrumentations();
    // INFRACAP-03/04: gate on an active Morse trace + per-trace cap. Without
    // this the community instrumentations start an orphan root span for any
    // query made outside a trace and have no cap.
    const off = getEngine().registerInstrumentations(instrumentations, (provider) =>
      gateTracerProvider(provider, "db"),
    );
    if (off === null) return false;
    unregister = off;
    registeredInstrumentations = instrumentations;
    return true;
  } catch {
    unregister = null;
    registeredInstrumentations = null;
    return false;
  }
}

/** Unregister DB auto-capture (idempotent). Primarily for tests. */
export function disableDbCapture(): void {
  if (unregister !== null) {
    try {
      unregister();
    } catch {
      // Best-effort.
    }
  }
  unregister = null;
  registeredInstrumentations = null;
}

/** @internal test hook — the currently-registered instrumentation instances, or null. */
export function _getRegisteredInstrumentationsForTesting(): Instrumentation[] | null {
  return registeredInstrumentations;
}

/**
 * Called from `index.ts::buildSingleton()` after `getOtelEngine().configure()`.
 * Enables DB capture unless switched off — mirrors Python's
 * `infra_capture.py::maybe_enable_from_env`:
 *
 * - `MORSE_CAPTURE_DB=0`    -> no DB capture
 * - `MORSE_CAPTURE_INFRA=0` -> no DB capture (a specific flag wins)
 */
export function maybeEnableDbCaptureFromEnv(): void {
  if (isDbCaptureEnabled()) {
    registerDbInstrumentation();
  }
}
