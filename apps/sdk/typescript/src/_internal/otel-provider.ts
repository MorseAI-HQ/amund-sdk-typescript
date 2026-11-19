/**
 * OTel-backed transport engine for the v2 tracing primitives (MHQ-482 —
 * TypeScript SDK parity port of the Python SDK's `otel_provider.py`,
 * MHQ-668).
 *
 * Architecture
 * ------------
 * `run()` / `span()` / `runTraced()` still build the same in-memory
 * `TraceState` / `SpanData` structures they always have (see
 * `tracing.ts` — nothing there changed for adapters). What changed is what
 * happens to that data once a trace closes: instead of JSON-encoding it and
 * handing it to the hand-rolled queue + `setInterval` HTTP sender
 * (`transport.ts`, now used only by `track()` / `batchTrack()` / `record()`
 * / `log()` — see their call sites), the trace's already-built wire dict
 * (the same shape `getLastTrace()` returns) is converted into real
 * `@opentelemetry/sdk-trace-base` `Span` objects and handed to a standard
 * OTel pipeline:
 *
 *     tracer.startSpan() / span.end()
 *         -> BatchSpanProcessor (stdlib OTel: 512 batch / 5s / 2048 queue
 *            defaults, overridable via env)
 *         -> RedactingSpanExporter (this module — delegating wrapper)
 *         -> DropReportingExporter (this module — delivery-loss counter)
 *         -> OTLPTraceExporter (@opentelemetry/exporter-trace-otlp-proto,
 *            protobuf + gzip, POSTs to `<endpoint>/api/v1/otlp/v1/traces`)
 *
 * Why convert at trace-close time rather than incrementally as each span
 * enters/exits: mirrors the Python design so both SDKs share one mental
 * model, and leaves room for future adapters that build `SpanData` objects
 * directly (bypassing the `startSpan`/`span()` helpers) to keep working
 * unmodified — they only ever touch `tracing.ts`'s `completedSpans` list,
 * never this module or `transport.ts`.
 *
 * Trace/span identifiers
 * -----------------------
 * Morse's own `trace_id` (32 hex chars / 128 bits, see `spans.ts`) maps 1:1
 * onto OTel's 128-bit `TraceId`. Morse's `span_id` is ALSO a 32-hex value —
 * but OTel's `SpanId` is only 64 bits (16 hex chars). There is no lossless
 * mapping, and none is needed: span ids are wire-protocol-local
 * identifiers, not semantic content, and the server already round-trips
 * OTel's 64-bit span ids by zero-extending them into the 128-bit UUID
 * column (mirrors `adapters/otlp.py::_hex_span_id_to_uuid` server-side).
 * Deferred spans use the first 16 hex digits of their Morse span ID, matching
 * the live context propagated to DB instrumentation. Other OTel spans use
 * random IDs. The trace ID is forced via the
 * same "synthetic remote parent" technique used for W3C traceparent
 * continuation (see `propagation.ts`): a non-recording `Span` wrapping a
 * `SpanContext` with the desired `traceId` and a pre-computed `sampled`
 * flag is set as the parent context for `tracer.startSpan()`, so every span
 * in the trace (root included) inherits the same trace id and the same
 * sampling decision.
 *
 * Node-only: unlike the rest of the TS SDK (which has to tolerate a
 * browser runtime for the module-level singleton), this module is only
 * ever loaded from `tracing.ts`'s Node-only `sendTrace()` path (guarded the
 * same way `_internal/tracing.ts`'s `AsyncLocalStorage` require is) and
 * imports Node-only OTel packages (`@opentelemetry/sdk-trace-node`,
 * `@opentelemetry/exporter-trace-otlp-proto`'s Node build). No browser
 * build target is provided for this module.
 */

import { createHash } from "node:crypto";

import {
  context as otelContext,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace as traceApi,
  type Span as OtelSpan,
  type SpanContext,
  type Tracer as OtelTracer,
} from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  RandomIdGenerator,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Sampler,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import {
  isAuthError,
  isNetworkError,
  noteDelivered,
  noteRetrying,
  recordDrop,
  report,
  REASON_AUTH_REJECTED,
  REASON_ENDPOINT_REJECTED,
  REASON_QUOTA_REJECTED,
  REASON_RETRY_EXHAUSTED,
  REASON_SEND_FAILED,
} from "./diagnostics";
import type { TracerProvider } from "@opentelemetry/api";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { scrubDbSpan } from "./infra-shared";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";

import { readEnvServiceName } from "./agent-name";
import { assignPromptRefsToSpans, safeEntries, warnPromptSpanShared } from "./attribution";
import { redactString, type RedactionConfig } from "./redaction";
import { SDK_VERSION } from "./transport";
import { otelSpanIdFor } from "./span-ids";

const INSTRUMENTATION_NAME = "morse-typescript";
export const DEFAULT_MAX_FIELD_BYTES = 65536;
export const TRUNCATION_MARKER = "…[truncated]";

/* ------------------------------------------------------------------------ */
/*  SDK resource (MHQ-1100)                                                  */
/* ------------------------------------------------------------------------ */

type ProviderResource = NonNullable<
  NonNullable<ConstructorParameters<typeof NodeTracerProvider>[0]>["resource"]
>;

/**
 * Resource carrying telemetry-SDK identity and, when set in the process
 * environment, `morse.process.service_name` — never `service.name`.
 *
 * Implements the (small, stable) OTel `Resource` interface directly rather
 * than importing `@opentelemetry/resources`, which is only a transitive
 * dependency of this package (see the dependency-skew note in `configure`).
 */
export function buildSdkResource(
  processServiceName?: string,
  identity: { gitRevision?: string; serviceVersion?: string } = {},
): ProviderResource {
  const attributes: Record<string, string> = {
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.name": "opentelemetry",
  };
  if (processServiceName) attributes["morse.process.service_name"] = processServiceName;
  // ATTR-06: `git.revision` and `service.version` are real OTel resource attributes,
  // so unlike `service.name` they are safe to carry (ingest does not read them as an
  // agent name).
  if (identity.gitRevision) attributes["git.revision"] = identity.gitRevision;
  if (identity.serviceVersion) attributes["service.version"] = identity.serviceVersion;
  const make = (attrs: Record<string, string>): ProviderResource => {
    const res = {
      attributes: attrs,
      asyncAttributesPending: false,
      getRawAttributes: () => Object.entries(attrs),
      merge(other: { attributes?: Record<string, unknown> } | null): ProviderResource {
        const merged: Record<string, string> = { ...attrs };
        for (const [k, v] of Object.entries(other?.attributes ?? {})) {
          if (k !== "service.name" && v !== undefined && v !== null) merged[k] = String(v);
        }
        return make(merged);
      },
    };
    return res as unknown as ProviderResource;
  };
  return make(attributes);
}

/* ------------------------------------------------------------------------ */
/*  Global OTel context propagation (MHQ-482 db-capture correlation)        */
/* ------------------------------------------------------------------------ */

let contextManagerRegistered = false;

/**
 * Register a real, async-hooks-backed `ContextManager` on the GLOBAL
 * `@opentelemetry/api` context API, once per process.
 *
 * Why this is needed: `emitTraceEntry` never calls
 * `NodeTracerProvider.register()` (deliberately — see the module docstring;
 * registering would hijack the process's global tracer provider, forcing
 * every OTel-instrumented library in the host app through Morse's
 * exporter). But community DB-driver instrumentation packages (MHQ-482,
 * `./db-capture.ts`) read the *global* `context.active()` to find their
 * parent span — with no `ContextManager` registered, `@opentelemetry/api`
 * defaults to a no-op manager and `context.active()` is always
 * `ROOT_CONTEXT`, so DB spans would never nest under an active
 * `morse.span()` block.
 *
 * Registering a `ContextManager` (unlike `register()`) does NOT swap the
 * global tracer provider or propagator — it only makes `context.with()` /
 * `context.active()` actually track the active context across async
 * boundaries via `async_hooks`, which is exactly what
 * `withOtelSpanContext` below and the instrumentation packages both need.
 * `setGlobalContextManager` is itself idempotent/best-effort: if the host
 * app already registered its own (e.g., via `@opentelemetry/sdk-node`),
 * this call is a documented no-op (the API logs a diag warning and keeps
 * the existing one) — never a crash.
 */
function ensureGlobalContextManager(): void {
  if (contextManagerRegistered) return;
  contextManagerRegistered = true;
  try {
    otelContext.setGlobalContextManager(new AsyncHooksContextManager().enable());
  } catch {
    // Best-effort — DB span *export* still succeeds either way; only
    // parent/child nesting via `context.active()` degrades (each DB span
    // becomes its own root instead of nesting under the active
    // `morse.span()`).
  }
}

/**
 * Set the OTel-global active context to a synthetic `SpanContext` carrying
 * `traceIdHex`/`spanIdHex`, then run `fn` inside it. Used by
 * `tracing.ts::spanSync`/`spanAsync`/`runSync`/`runAsync` (MHQ-482) so
 * community DB instrumentation invoked inside a `morse.span()`/`morse.run()`
 * block picks up the right trace id and nests under the right parent span
 * id via the normal OTel context-propagation `context.active()` path — the
 * same correlation mechanism `emitTraceEntry`'s synthetic-parent technique
 * uses for Morse's own deferred spans, applied live instead of at
 * trace-close time.
 *
 * No-op passthrough (just calls `fn()`) if the engine hasn't been
 * configured yet, mirroring the rest of this module's silent-no-transport
 * contract.
 */
export function withOtelSpanContext<T>(traceIdHex: string, spanIdHex: string, fn: () => T): T {
  const eng = getEngine();
  if (eng.provider === null) return fn();
  ensureGlobalContextManager();
  const sampled = eng.resolveSampled(traceIdHex);
  const spanCtx: SpanContext = {
    traceId: traceIdHex,
    spanId: spanIdHex,
    isRemote: true,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
  const withCtx = traceApi.setSpanContext(otelContext.active(), spanCtx);
  return otelContext.with(withCtx, fn);
}

// OTel BatchSpanProcessor stock defaults — documented here for readers;
// the actual defaults are baked into `_internal/env.ts`'s
// `getMaxQueueSize()` (2048) / `getMaxBatchSize()` (512), and the schedule
// delay is derived from `flushIntervalSeconds` at the `init()` call site
// (`index.ts`), not read directly by this module. Mirrors the Python
// module's `_DEFAULT_*` constants.

/* ------------------------------------------------------------------------ */
/*  Byte-cap helpers (applied at attribute-set time — MORSE_MAX_FIELD_BYTES) */
/* ------------------------------------------------------------------------ */

/**
 * Truncate `value` to `maxBytes` (UTF-8), appending the truncation marker.
 * No-op if already within the cap. Never splits a multi-byte UTF-8
 * codepoint.
 */
export function capBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return value;
  const encoded = Buffer.from(value, "utf-8");
  if (encoded.length <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
  const budget = Math.max(maxBytes - markerBytes, 0);
  let truncated = encoded.subarray(0, budget);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (truncated.length > 0) {
    try {
      return decoder.decode(truncated) + TRUNCATION_MARKER;
    } catch {
      truncated = truncated.subarray(0, truncated.length - 1);
    }
  }
  return TRUNCATION_MARKER;
}

/**
 * JSON-encode `value` and byte-cap the result.
 *
 * `null`/`undefined` in -> `null` out (caller omits the attribute
 * entirely). String values are capped BEFORE encoding so the result stays
 * valid JSON. Structured (object/array) values are encoded fully, then
 * capped as a raw string if oversized — on the rare oversized-structured-
 * payload path this can produce a value that no longer parses as JSON
 * server side; the server's tolerant-JSON adapters already drop
 * unparseable blobs as a whole, so this is a safety valve against
 * unbounded payload growth, not a guarantee of partial preservation
 * (mirrors Python's `json_capped`).
 */
export function jsonCapped(value: unknown, maxBytes: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return JSON.stringify(capBytes(value, maxBytes));
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ?? "null";
  } catch {
    encoded = JSON.stringify(String(value));
  }
  return capBytes(encoded, maxBytes);
}

/* ------------------------------------------------------------------------ */
/*  Sampler — deterministic trace-ID ratio, whole-trace, decorrelated       */
/* ------------------------------------------------------------------------ */

/**
 * Return a value uniformly distributed over the full 128-bit range for
 * sampling purposes, decorrelated from `traceIdHex`'s UUIDv4 variant bits.
 * See `OtelEngine.resolveSampled` for why this exists — feeding a raw
 * uuid4 straight to a ratio-based sampler produces a hard 0%/100% step
 * function instead of a ratio (mirrors Python's
 * `_decorrelate_trace_id_for_sampling`).
 */
function decorrelateTraceIdForSampling(traceIdHex: string): Buffer {
  const traceIdBytes = Buffer.from(traceIdHex.padStart(32, "0").slice(0, 32), "hex");
  return createHash("sha256").update(traceIdBytes).digest();
}

const MAX_U64 = (1n << 64n) - 1n;

/**
 * Deterministic ratio-based sample decision, matching the standard OTel
 * `TraceIdRatioBased` algorithm (compare the low 64 bits of the id against
 * `round(rate * 2**64 - 1)`), but fed a SHA-256-decorrelated id instead of
 * the raw trace id — see `decorrelateTraceIdForSampling`.
 */
export function ratioSample(traceIdHex: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const digest = decorrelateTraceIdForSampling(traceIdHex);
  // Low 64 bits of the 128-bit decorrelated id: bytes [8:16) of the digest
  // prefix (digest[0:16] is what Python treats as the 128-bit decorrelated
  // int; its low 64 bits are its last 8 bytes).
  const low64 = digest.subarray(8, 16).readBigUInt64BE();
  const threshold = BigInt(Math.round(rate * Number(MAX_U64)));
  return low64 < threshold;
}

/* ------------------------------------------------------------------------ */
/*  Redacting exporter — single redaction pass, off the hot path            */
/* ------------------------------------------------------------------------ */

function redactAttrValue(value: unknown, config: RedactionConfig): unknown {
  if (typeof value === "string") return redactString(value, config);
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? redactString(v, config) : v));
  }
  return value;
}

/**
 * Delegating `SpanExporter`: redacts span attribute string values in
 * `export()` (called on the `BatchSpanProcessor`'s background flush —
 * never on the caller's hot path), then forwards to the real OTLP
 * exporter. This is the SDK's single PII-redaction pass for the tracing
 * pipeline; nothing upstream of this (`tracing.ts`,
 * `otel-provider.ts::emitTraceEntry`) redacts anything for THIS pipeline
 * (see the module-level deviation note in the PR report re: `tracing.ts`'s
 * pre-existing `buildTraceDict`-time redaction, kept for `_getLastTrace()`
 * parity and harmless to double-apply).
 *
 * Mutates `ReadableSpan.attributes` in place — safe because
 * `@opentelemetry/sdk-trace-base`'s `Span` class does not freeze
 * `attributes` on `.end()` (unlike Python's `BoundedAttributes`, which
 * requires reassigning the whole backing dict via a private field).
 */
class RedactingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly redactionConfig: RedactionConfig | null,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // INFRACAP-05: scrub inline SQL literals and drop bound-parameter
    // attributes from whatever DB instrumentation produced the span.
    for (const span of spans) {
      scrubDbSpan(span as unknown as Parameters<typeof scrubDbSpan>[0]);
    }
    const config = this.redactionConfig;
    if (config && (config.enabled || config.extraCompiled.length > 0)) {
      for (const span of spans) {
        const attrs = span.attributes;
        if (!attrs) continue;
        for (const key of Object.keys(attrs)) {
          attrs[key] = redactAttrValue(attrs[key], config) as never;
        }
      }
    }
    this.inner.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

/**
 * Name the failure the way `transport.ts` names the same one — MHQ-971
 * established that a revoked key, a wrong URL and a rate limit must not all
 * arrive looking alike.
 *
 * `OTLPExporterError.code` is the HTTP status, and it is present only for
 * statuses the exporter treats as non-retryable. A retryable one (429, 5xx)
 * and a network fault both reach the callback with the status already
 * discarded — the exporter retried, honoured `Retry-After`, and used up its
 * budget, which is precisely `retry_exhausted`.
 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function dropReasonForExportError(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "number") return REASON_RETRY_EXHAUSTED;
  if (code === 429) return REASON_QUOTA_REJECTED;
  if (code === 401 || code === 403) return REASON_AUTH_REJECTED;
  if (code >= 400 && code < 500) return REASON_ENDPOINT_REJECTED;
  return REASON_SEND_FAILED;
}

/**
 * Delegating `SpanExporter` that counts what the OTLP exporter permanently
 * discards (MHQ-1030).
 *
 * A failed export is one log line from the OTel SDK and a `FAILED` result the
 * `BatchSpanProcessor` drops without a word, so a rate-limited window and a
 * healthy one look identical to the app AND to us. That is the failure mode
 * Morse exists to prevent; it does not get to live in Morse's own SDK.
 * Delivery is untouched — this only counts.
 */
export class DropReportingExporter implements SpanExporter {
  /**
   * @param host Endpoint host, named in the plain "unreachable" warning (MHQ-1838).
   * @param slowNoticeMs After this long without an answer the host is told the SDK is retrying,
   *   once per outage, so the wait before a drop is not silent. Text only: the timer is unref'd and
   *   cleared on the answer, and delivery and retry timing are untouched.
   */
  constructor(
    private readonly inner: SpanExporter,
    private readonly host?: string,
    private readonly slowNoticeMs = 1_500,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let slowTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      slowTimer = setTimeout(() => noteRetrying(this.host, true), this.slowNoticeMs);
      (slowTimer as { unref?: () => void }).unref?.();
    } catch {
      slowTimer = null;
    }
    this.inner.export(spans, (result) => {
      if (slowTimer !== null) clearTimeout(slowTimer);
      // recordDrop never throws, but this callback runs on the exporter's
      // own path — a fault here must not cost the caller its callback.
      try {
        if (result.code === ExportResultCode.FAILED) {
          recordDrop(dropReasonForExportError(result.error), "span", spans.length, {
            status: (result.error as { code?: unknown } | undefined)?.code as number | undefined,
            host: this.host,
            unreachable: isNetworkError(result.error),
          });
        } else {
          noteDelivered();
        }
      } catch {
        // Counting must never break export.
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

/**
 * Test-only in-memory exporter: mirrors whatever the redacting exporter
 * saw (i.e. POST-redaction data) so tests can inspect exported spans
 * without a live collector. Wrapped BEHIND the redacting exporter so it
 * observes the same redacted values the wire would carry.
 */
export class RecordingSpanExporter implements SpanExporter {
  spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  clear(): void {
    this.spans = [];
  }
}

/* ------------------------------------------------------------------------ */
/*  Provider singleton                                                      */
/* ------------------------------------------------------------------------ */

export interface OtelEngineConfigureOptions {
  endpoint: string;
  apiKey: string;
  sampleRate: number;
  scheduleDelayMillis: number;
  maxQueueSize: number;
  maxExportBatchSize: number;
  maxFieldBytes: number;
  timeoutMillis: number;
  redactionConfig: RedactionConfig | null;
  captureForTests?: boolean;
  /** ATTR-06: detected deployment identity, stamped on the OTel Resource. */
  gitRevision?: string;
  serviceVersion?: string;
  /**
   * Observe the real OTLP exporter's `ExportResult` for every flush, without
   * altering delivery. Used by `dogfood/smoke.ts` to assert the live dev-api
   * OTLP endpoint actually accepted the wire payload — the same class of
   * check `transport.ts`'s wire-format smoke coverage does for the legacy
   * JSON path (see `apps/sdk/typescript/CLAUDE.md`'s wire-format contract
   * rule). Not used by production `init()`.
   */
  resultSink?: (result: ExportResult) => void;
}

/**
 * Delegating `SpanExporter`: forwards to `inner`, calling `sink` with each
 * `ExportResult` before invoking the caller's callback. Purely an
 * observability tap — never alters the result or delays delivery.
 */
class ResultCapturingExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly sink: (result: ExportResult) => void,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      this.sink(result);
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

/** Preserve the IDs already propagated to live DB instrumentation. */
class MorseIdGenerator extends RandomIdGenerator {
  nextSpanId: string | undefined;

  private readonly randomIds = new RandomIdGenerator();
  override generateSpanId = (): string => this.nextSpanId ?? this.randomIds.generateSpanId();
}

/** Lazily-built TracerProvider + exporter chain. One per process. */
export class OtelEngine {
  provider: NodeTracerProvider | null = null;
  tracer: OtelTracer | null = null;
  sampleRate = 1.0;
  recorder: RecordingSpanExporter | null = null;
  maxFieldBytes: number = DEFAULT_MAX_FIELD_BYTES;
  private exitHookRegistered = false;
  readonly idGenerator = new MorseIdGenerator();

  /**
   * (Re)build the provider. Mirrors Python's `_Client.__init__` semantics:
   * calling this again (e.g. a second `init()`) tears down the previous
   * provider first (fire-and-forget — Node has no synchronous blocking
   * shutdown equivalent to Python's `atexit`).
   */
  configure(opts: OtelEngineConfigureOptions): void {
    if (this.provider !== null) {
      const prior = this.provider;
      void prior.shutdown().catch(() => {
        // Swallowed — mirrors Python's best-effort prior-provider teardown.
      });
    }

    this.maxFieldBytes = opts.maxFieldBytes;
    this.sampleRate = Math.min(1, Math.max(0, opts.sampleRate));

    const sampler: Sampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(this.sampleRate),
    });
    // MHQ-1100: explicit resource WITHOUT `service.name`. The provider's
    // bundled default stamps `unknown_service:<argv0>` (and a host's
    // OTEL_SERVICE_NAME can end up there too); Morse ingest treats a real
    // `service.name` as the agent name, so the SDK resource must not carry
    // one. The process service name is kept as `morse.process.service_name`.
    // Built structurally (not via `@opentelemetry/resources`) so this module
    // takes no new direct dependency — see `buildSdkResource`.
    const resource = buildSdkResource(readEnvServiceName(), {
      gitRevision: opts.gitRevision,
      serviceVersion: opts.serviceVersion,
    });

    const otlpExporter = new OTLPTraceExporter({
      url: opts.endpoint,
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      compression: CompressionAlgorithm.GZIP,
      timeoutMillis: opts.timeoutMillis,
    });
    let exporter: SpanExporter = new RedactingSpanExporter(
      new DropReportingExporter(otlpExporter, hostOf(opts.endpoint)),
      opts.redactionConfig,
    );
    if (opts.resultSink) {
      exporter = new ResultCapturingExporter(exporter, opts.resultSink);
    }

    this.recorder = opts.captureForTests ? new RecordingSpanExporter() : null;

    const spanProcessors: SpanProcessor[] = [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: opts.maxQueueSize,
        scheduledDelayMillis: opts.scheduleDelayMillis,
        maxExportBatchSize: opts.maxExportBatchSize,
      }),
    ];
    if (this.recorder !== null) {
      // Second processor: independent in-memory capture so tests can
      // inspect exported spans without a live collector. Runs its own
      // BatchSpanProcessor so it doesn't share queue pressure with the
      // real exporter.
      spanProcessors.push(new BatchSpanProcessor(this.recorder));
    }

    this.provider = new NodeTracerProvider({
      sampler,
      spanProcessors,
      resource,
      idGenerator: this.idGenerator,
    });
    // The scope version is how the server stamps `traces.sdk_version` on the
    // OTLP path (MHQ-1158); without it every trace read `otlp/http`.
    this.tracer = this.provider.getTracer(INSTRUMENTATION_NAME, SDK_VERSION);

    if (!this.exitHookRegistered) {
      process.once("beforeExit", () => {
        this.shutdown();
      });
      this.exitHookRegistered = true;
    }
  }

  shutdown(): void {
    if (this.provider !== null) {
      const provider = this.provider;
      void provider.shutdown().catch(() => {
        // Swallowed — best-effort on process exit.
      });
      this.provider = null;
      this.tracer = null;
    }
  }

  /**
   * Test-only fast reset: drop the provider reference WITHOUT blocking on
   * `shutdown()`. Mirrors Python's `reset_for_testing` — the OTLP
   * exporter's retry-with-backoff behavior against an unreachable test
   * endpoint would otherwise make every test file's teardown slow. The
   * queued background work is not awaited; it either finishes or is
   * abandoned with the process, same trade-off as Python's daemon worker
   * thread.
   */
  resetForTesting(): void {
    this.provider = null;
    this.tracer = null;
    this.recorder = null;
  }

  /**
   * The engine's tracer, for third-party code that accepts a `Tracer`
   * (MHQ-1216: the Vercel AI SDK's OpenTelemetry integrations). Spans started
   * from it flow through the same sampler -> `BatchSpanProcessor` ->
   * `RedactingSpanExporter` -> OTLP chain as every other SDK span, WITHOUT
   * registering Morse's provider as the process-global one.
   *
   * Also installs the global async-hooks `ContextManager` (idempotent, see
   * `ensureGlobalContextManager`): `startActiveSpan` / `context.with` only
   * nest child spans under their parent when one exists, and the SDK
   * deliberately does not call `provider.register()` (which would install it).
   *
   * `null` until `configure()` has run (and again after `shutdown()`), so
   * callers can tell "not initialised" from "initialised".
   */
  getTracer(): OtelTracer | null {
    if (this.tracer === null) return null;
    ensureGlobalContextManager();
    return this.tracer;
  }

  /** Block until in-flight exports finish (or the timeout elapses). */
  async flush(): Promise<void> {
    const provider = this.provider;
    if (provider !== null) {
      try {
        await provider.forceFlush();
      } catch (err) {
        // Swallowed — mirrors Python's force_flush() debug-log-and-continue.
        // A rejected key or an unreachable endpoint was already explained by
        // the plain drop warning; the raw exporter error is debug-only.
        reportSwallowed(
          err,
          "morse.otel_provider.force_flush",
          isAuthError(err) || isNetworkError(err),
        );
      }
    }
  }

  /**
   * Run the deterministic ratio sampler directly for a trace id with no
   * real parent. See `ratioSample` for the decorrelation rationale — feeding
   * a raw uuid4 trace id straight to a ratio sampler produces a hard
   * 0%/100% step function because of uuid4's fixed variant bits.
   */
  resolveSampled(traceIdHex: string): boolean {
    return ratioSample(traceIdHex, this.sampleRate);
  }

  /**
   * Register OTel `Instrumentation` instances (e.g. the community DB-driver
   * auto-instrumentation packages, see `./db-capture.ts`, MHQ-482) against
   * THIS engine's `NodeTracerProvider` — so spans they emit flow through
   * the same `BatchSpanProcessor` -> `RedactingSpanExporter` ->
   * `OTLPTraceExporter` pipeline `configure()` built, landing in the same
   * OTLP stream (and, when nested inside an active OTel context, the same
   * trace) as the rest of the SDK's spans.
   *
   * No-op (silently, returns `null`) if `configure()` hasn't run yet —
   * mirrors `emitTraceEntry`'s "no transport configured -> silent"
   * contract. Callers (`index.ts::buildSingleton`) must call this AFTER
   * `configure()`.
   */
  registerInstrumentations(
    instrumentations: Instrumentation[],
    wrapProvider?: (provider: TracerProvider) => TracerProvider,
  ): (() => void) | null {
    if (this.provider === null) return null;
    return registerInstrumentations({
      tracerProvider: wrapProvider ? wrapProvider(this.provider) : this.provider,
      instrumentations,
    });
  }
}

let engine: OtelEngine | null = null;

export function getEngine(): OtelEngine {
  if (engine === null) engine = new OtelEngine();
  return engine;
}

/**
 * True in the Node build. The browser build
 * (`otel-provider.browser.ts`, selected by package.json's `"browser"`
 * export condition) returns false, which routes `tracing.ts::sendTrace`
 * down the JSON transport instead of the OTLP pipeline that cannot exist
 * there. Kept as a function rather than a const so both modules present an
 * identical shape.
 */
export function isOtelAvailable(): boolean {
  return true;
}

/* ------------------------------------------------------------------------ */
/*  Attribute mapping — trace-entry dict -> OTel attributes                 */
/* ------------------------------------------------------------------------ */

type AttrValue = string | number | boolean;

function spanDictToOtelAttributes(
  spanDict: Record<string, unknown>,
  traceDict: Record<string, unknown>,
  resourceDict: Record<string, unknown>,
  opts: {
    isRoot: boolean;
    maxFieldBytes: number;
    /** ATTR-04: the single prompt reference assigned to this span, if any. */
    prompt?: { name: string; version?: number; link_source?: "fetch" };
  },
): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {};

  const spanType = spanDict.type;
  if (typeof spanType === "string" && spanType) attrs["morse.span_type"] = spanType;

  const model = spanDict.model;
  if (model !== undefined && model !== null) attrs["gen_ai.request.model"] = String(model);

  const tokenFields: ReadonlyArray<readonly [string, string]> = [
    ["input_tokens", "gen_ai.usage.input_tokens"],
    ["output_tokens", "gen_ai.usage.output_tokens"],
    ["cached_input_tokens", "gen_ai.usage.cache_read_input_tokens"],
    ["cache_write_tokens", "gen_ai.usage.cache_creation_input_tokens"],
    ["reasoning_tokens", "gen_ai.usage.reasoning_tokens"],
  ];
  for (const [src, otelKey] of tokenFields) {
    const v = spanDict[src];
    if (v !== undefined && v !== null) {
      const n = Number(v);
      if (Number.isFinite(n)) attrs[otelKey] = Math.trunc(n);
    }
  }

  const costUsd = spanDict.cost_usd;
  if (costUsd !== undefined && costUsd !== null) {
    // morse.cost_usd: direct SDK/adapter-computed cost (pricing-table based) —
    // distinct from gen_ai.usage.cost (provider-billing-reported).
    // Stringify to preserve precision across the wire.
    attrs["morse.cost_usd"] = String(costUsd);
  }

  for (const [src, otelKey] of [
    ["input_data", "morse.input_data"],
    ["output_data", "morse.output_data"],
    ["context_segments", "morse.context_segments"],
  ] as const) {
    const v = spanDict[src];
    if (v !== undefined && v !== null) {
      const encoded = jsonCapped(v, opts.maxFieldBytes);
      if (encoded !== null) attrs[otelKey] = encoded;
    }
  }

  // Arbitrary custom metadata. Each top-level key is namespaced under
  // `morse.metadata.<key>` so the server's OTLP translation layer can pop +
  // un-prefix + JSON-decode them back into a clean metadata dict.
  const metadata = spanDict.metadata;
  if (metadata && typeof metadata === "object") {
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
      const encoded = jsonCapped(value, opts.maxFieldBytes);
      if (encoded !== null) attrs[`morse.metadata.${key}`] = encoded;
    }
  }

  const errorMessage = spanDict.error_message;
  // Trace-level fields only travel on the root span.
  if (opts.isRoot) {
    // MHQ-1100: the resolved agent name rides the root span; ingest reads it
    // in preference to any resource-level service.name.
    const agent = traceDict.agent;
    if (typeof agent === "string" && agent) attrs["morse.agent"] = agent;
    // AID-01/AID-04: how the name was resolved, and the run() label. Server reads
    // `morse.app` into trace metadata `morse_app`; `morse.identity_source` -> `identity_source`.
    const traceMeta = traceDict.metadata as Record<string, unknown> | undefined;
    if (typeof traceMeta?.identity_source === "string") {
      attrs["morse.identity_source"] = traceMeta.identity_source;
    }
    if (typeof traceMeta?.morse_app === "string" && traceMeta.morse_app) {
      attrs["morse.app"] = traceMeta.morse_app;
    }
    const threadId = traceDict.thread_id;
    if (threadId !== undefined && threadId !== null) attrs["morse.thread_id"] = String(threadId);
    const userId = traceDict.user_id;
    if (userId !== undefined && userId !== null) attrs["morse.user_id"] = String(userId);
    const userMetadata = traceDict.user_metadata;
    if (userMetadata && typeof userMetadata === "object") {
      const entries = Object.entries(userMetadata as Record<string, unknown>);
      if (entries.length > 0) {
        attrs["morse.user_metadata"] = JSON.stringify(
          Object.fromEntries(entries.map(([k, v]) => [k, String(v)])),
        );
      }
    }
    const success = traceDict.success;
    if (success !== undefined && success !== null)
      attrs["morse.outcome.success"] = Boolean(success);
    const outcome = traceDict.outcome;
    if (outcome !== undefined && outcome !== null) attrs["morse.outcome.label"] = String(outcome);
    const framework = resourceDict["morse_ai.framework"];
    if (typeof framework === "string" && framework) attrs["morse.framework"] = framework;
    const source = resourceDict["morse_ai.source"];
    if (typeof source === "string" && source) attrs["morse.source"] = source;
    // ATTR-01: one `morse.record_key.<type>` attribute per key. Types were
    // lower-cased and validated when set, so the attribute name is safe.
    for (const [type, value] of safeEntries(traceDict.record_keys)) {
      if (typeof value === "string" && value) attrs[`morse.record_key.${type}`] = value;
    }
    // ATTR-04: the declared agent version rides the root span (server: first value wins).
    const agentVersion = traceDict.agent_version;
    if (typeof agentVersion === "string" && agentVersion) {
      attrs["morse.agent_version"] = agentVersion;
    }
  }
  // ATTR-04: a prompt reference sits on the span `setPrompt()` ran in, or the root.
  if (opts.prompt) {
    attrs["morse.prompt.name"] = opts.prompt.name;
    if (opts.prompt.version !== undefined) attrs["morse.prompt.version"] = opts.prompt.version;
    // UP-09: only "fetch" is sent; absent means declared.
    if (opts.prompt.link_source === "fetch") attrs["morse.prompt.link_source"] = "fetch";
  }

  if (errorMessage && spanDict.status === "failed") {
    attrs["morse.error_message"] = String(errorMessage);
  }
  if (spanDict.exception_type && spanDict.status === "failed") {
    attrs["morse.exception_type"] = String(spanDict.exception_type);
  }

  return attrs;
}

function isoToTimeInputMillis(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/* ------------------------------------------------------------------------ */
/*  Public entry point                                                      */
/* ------------------------------------------------------------------------ */

export interface TraceEntryLike {
  trace?: Record<string, unknown>;
  spans?: Array<Record<string, unknown>>;
  resource?: Record<string, unknown>;
}

/**
 * Convert one already-built wire-format trace entry (the same shape
 * `tracing.ts::buildTraceDict` produces / `getLastTrace()` returns) into
 * real OTel spans and hand them to the configured pipeline.
 *
 * No-op (silently) if the engine hasn't been configured yet — mirrors the
 * "no transport configured -> silent" contract the rest of the SDK
 * follows.
 */
export function emitTraceEntry(entry: TraceEntryLike): void {
  const eng = getEngine();
  const tracer = eng.tracer;
  if (tracer === null) return;

  const traceDict = entry.trace ?? {};
  const spanDicts = entry.spans ?? [];
  const resourceDict = entry.resource ?? {};
  if (spanDicts.length === 0) return;

  const traceIdHexRaw = traceDict.trace_id;
  if (typeof traceIdHexRaw !== "string" || traceIdHexRaw.length === 0) return;
  const traceIdHex = traceIdHexRaw.toLowerCase().padStart(32, "0").slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(traceIdHex) || /^0+$/.test(traceIdHex)) return;

  const sampled = eng.resolveSampled(traceIdHex);
  const syntheticParentContext: SpanContext = {
    traceId: traceIdHex,
    // Placeholder — only traceId/traceFlags matter here; every real span
    // in the trace gets its own OTel-minted spanId via startSpan().
    spanId: "0000000000000001",
    isRemote: true,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
  const rootParentCtx = traceApi.setSpanContext(ROOT_CONTEXT, syntheticParentContext);

  let rootSpanId: unknown;
  for (const s of spanDicts) {
    if (!s.parent_span_id) {
      rootSpanId = s.span_id;
      break;
    }
  }
  if (rootSpanId === undefined && spanDicts.length > 0) {
    rootSpanId = spanDicts[0]!.span_id;
  }

  // Root first, then children — so a child's parent SpanContext is always
  // available by the time we process it.
  const ordered = [...spanDicts].sort((a, b) => {
    const aIsRoot = a.span_id === rootSpanId ? 0 : 1;
    const bIsRoot = b.span_id === rootSpanId ? 0 : 1;
    return aIsRoot - bIsRoot;
  });

  const spanCtxById = new Map<string, SpanContext>();
  const maxFieldBytes = eng.maxFieldBytes;

  // ATTR-04: OTLP carries one prompt reference per span, so decide up front which
  // reference lands where. A ref whose span never finished falls back to the root.
  const knownSpanIds = new Set<string>();
  for (const s of spanDicts) if (typeof s.span_id === "string") knownSpanIds.add(s.span_id);
  const { bySpan: promptBySpan, overflow: promptOverflow } = assignPromptRefsToSpans(
    traceDict.prompts,
    knownSpanIds,
    typeof rootSpanId === "string" ? rootSpanId : undefined,
  );
  if (promptOverflow > 0) warnPromptSpanShared();

  for (const spanDict of ordered) {
    const spanIdHex = typeof spanDict.span_id === "string" ? spanDict.span_id : undefined;
    const parentIdHex =
      typeof spanDict.parent_span_id === "string" ? spanDict.parent_span_id : undefined;

    let parentCtx = rootParentCtx;
    if (parentIdHex && spanCtxById.has(parentIdHex)) {
      parentCtx = traceApi.setSpanContext(ROOT_CONTEXT, spanCtxById.get(parentIdHex)!);
    } else if (parentIdHex && /^[0-9a-f]{16,32}$/i.test(parentIdHex)) {
      // Children can finish before their parent; its stable wire ID is known.
      parentCtx = traceApi.setSpanContext(ROOT_CONTEXT, {
        ...syntheticParentContext,
        spanId: otelSpanIdFor(parentIdHex),
      });
    }

    const attributes = spanDictToOtelAttributes(spanDict, traceDict, resourceDict, {
      isRoot: spanDict.span_id === rootSpanId,
      maxFieldBytes,
      prompt: spanIdHex !== undefined ? promptBySpan.get(spanIdHex) : undefined,
    });
    const startTime = isoToTimeInputMillis(spanDict.started_at);
    const endTime = isoToTimeInputMillis(spanDict.ended_at) ?? startTime;

    try {
      // startSpan is synchronous; clear the override even if span creation fails.
      // MHQ-1880: the exported id is a pure function of the Morse span id, the
      // same one `propagation.ts` puts in an outgoing `traceparent` header.
      eng.idGenerator.nextSpanId = spanIdHex ? otelSpanIdFor(spanIdHex) : undefined;
      let otelSpan: OtelSpan;
      try {
        otelSpan = tracer.startSpan(
          typeof spanDict.name === "string" && spanDict.name ? spanDict.name : "span",
          {
            kind: SpanKind.INTERNAL,
            attributes,
            startTime,
          },
          parentCtx,
        );
      } finally {
        eng.idGenerator.nextSpanId = undefined;
      }
      if (spanIdHex) {
        spanCtxById.set(spanIdHex, otelSpan.spanContext());
      }
      if (spanDict.status === "failed") {
        // recordException-shaped event: exception.type / exception.message.
        const excAttrs: Record<string, string> = {};
        if (spanDict.exception_type) excAttrs["exception.type"] = String(spanDict.exception_type);
        if (spanDict.error_message) excAttrs["exception.message"] = String(spanDict.error_message);
        if (Object.keys(excAttrs).length > 0) otelSpan.addEvent("exception", excAttrs);
        otelSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(spanDict.error_message ?? ""),
        });
      }
      otelSpan.end(endTime);
    } catch (err) {
      // Never break the host app — mirrors Python's blanket except+debug-log.
      reportSwallowed(err, "morse.otel_provider.shutdown");
    }
  }
}

/**
 * Route a swallowed internal error to the diagnostics channel (SDKDIAG-07).
 *
 * Control flow is unchanged — the site still swallows, still returns the same
 * value. It is simply no longer invisible to us.
 */
function reportSwallowed(err: unknown, fingerprint: string, localOnlyInDebug = false): void {
  try {
    report(err, { fingerprint, localOnlyInDebug });
  } catch {
    // Reporting must never break the swallow it is reporting on.
  }
}
