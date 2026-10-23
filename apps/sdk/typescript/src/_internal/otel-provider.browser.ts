/**
 * Browser replacement for `otel-provider.ts` (MHQ-482 follow-up).
 *
 * Why this file exists
 * --------------------
 * `otel-provider.ts` is Node-only by construction — it statically imports
 * `@opentelemetry/sdk-trace-node`, `@opentelemetry/context-async-hooks`
 * (`async_hooks`), `@opentelemetry/instrumentation` (node `module`) and the
 * proto exporter's Node build. Because `index.ts` -> `tracing.ts` ->
 * `otel-provider.ts` is a static chain, ANY bundler targeting the browser
 * pulled those Node built-ins into the browser graph and failed to resolve
 * them. `tracing.ts`'s own docstring flagged this as a deferred decision
 * ("a future browser-targeted build would need ... to keep the JSON path as
 * the browser default"); this module is that decision, taken.
 *
 * The build swaps this module in for `otel-provider.ts` via the esbuild
 * plugin in `tsup.config.ts`, and `package.json`'s `"browser"` export
 * condition points browser bundlers at the resulting `dist/browser/*`. No
 * consumer configuration is involved — webpack, Turbopack, Vite, Rollup and
 * esbuild all honour the condition automatically.
 *
 * Behaviour, not a black hole
 * ---------------------------
 * Tracing still WORKS in the browser: `isOtelAvailable()` returns false, so
 * `tracing.ts::sendTrace` routes traces down the legacy JSON transport
 * (the same path `MORSE_LEGACY_TRANSPORT=1` selects in Node) instead of
 * dropping them. What is genuinely unavailable in a browser is the OTLP
 * span pipeline and DB-driver instrumentation; `noteBrowserRuntime()` says
 * so once, out loud, rather than leaving an integrator to wonder why their
 * spans look different from the Node docs.
 */

/** Public surface mirrors `otel-provider.ts` exactly — see that module. */
export interface OtelEngineConfigureOptions {
  apiKey?: string | undefined;
  endpoint?: string | undefined;
  sampleRate?: number | undefined;
  maxFieldBytes?: number | undefined;
  redaction?: unknown;
  [key: string]: unknown;
}

export interface TraceEntryLike {
  trace: Record<string, unknown>;
  spans: Record<string, unknown>[];
}

let warned = false;

/**
 * Emit the one-time "you are on the browser build" notice.
 *
 * Deliberately `console.info`, not `warn`: nothing is broken and nothing
 * needs fixing — a warning here would train integrators to ignore the
 * console. Fires only once per bundle, and only when the SDK is actually
 * configured (i.e. the app really did initialize Morse), so a page that
 * merely imports the SDK stays silent.
 */
function noteBrowserRuntime(): void {
  if (warned) return;
  warned = true;
  try {
    console.info(
      "[morse] Browser build active: OpenTelemetry span export and database " +
        "capture are Node-only, so traces are sent via Morse's JSON transport " +
        "instead. Everything else — run()/span()/track() and W3C traceparent " +
        "propagation — behaves identically. Server-side code (Next.js route " +
        "handlers, RSC, Node services) automatically gets the full OTel pipeline.",
    );
  } catch {
    // A console-less runtime is not a reason to fail a customer's app.
  }
}

/**
 * Browser stand-in for `OtelEngine`. Every method is a safe no-op with the
 * same signature, so `index.ts` needs no `typeof window` branches.
 */
export class OtelEngine {
  // Params are declared (not dropped) so this class stays signature-compatible
  // with the real `OtelEngine` — the build swaps the modules, but anything
  // type-checking against this one must see the same shape. `void x` marks the
  // deliberate non-use for @typescript-eslint/no-unused-vars.
  configure(opts: OtelEngineConfigureOptions): void {
    void opts;
    noteBrowserRuntime();
  }

  shutdown(): void {}

  resetForTesting(): void {
    warned = false;
  }

  async flush(): Promise<void> {}

  resolveSampled(traceIdHex: string): boolean {
    void traceIdHex;
    // Sampling in the browser is decided by the JSON transport path, which
    // applies its own rate — claiming "sampled" here would double-apply it.
    return true;
  }

  /**
   * No OTLP pipeline in a browser, so there is no tracer to hand out —
   * `null` is the same "not available" answer the Node engine gives before
   * `configure()` (MHQ-1216: `morseTelemetry()` reports it and no-ops).
   */
  getTracer(): null {
    return null;
  }

  registerInstrumentations(
    instrumentations: unknown[],
    wrapProvider?: unknown,
  ): (() => void) | null {
    void instrumentations;
    void wrapProvider;
    // DB-driver instrumentation requires `require-in-the-middle`; there is
    // nothing to hook in a browser.
    return null;
  }
}

const engine = new OtelEngine();

export function getEngine(): OtelEngine {
  return engine;
}

/**
 * False in the browser build — `tracing.ts::sendTrace` reads this to pick
 * the JSON transport instead of the (absent) OTLP pipeline.
 */
export function isOtelAvailable(): boolean {
  return false;
}

/**
 * Never called: `sendTrace` checks `isOtelAvailable()` first. Kept so the
 * module's shape matches `otel-provider.ts` (a shape mismatch would only
 * surface as a bundler error in a customer's build), and defensive — if it
 * ever IS reached, dropping the trace silently is the one outcome that must
 * not happen, so it reports rather than returning quietly.
 */
export function emitTraceEntry(entry: TraceEntryLike): void {
  void entry;
  noteBrowserRuntime();
  throw new Error("morse: OTLP export is unavailable in the browser build");
}

/** No live OTel context to enter in a browser — run `fn` unchanged. */
export function withOtelSpanContext<T>(traceIdHex: string, spanIdHex: string, fn: () => T): T {
  void traceIdHex;
  void spanIdHex;
  return fn();
}
