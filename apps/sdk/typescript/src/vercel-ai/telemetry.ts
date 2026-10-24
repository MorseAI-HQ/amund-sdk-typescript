/**
 * `morseTelemetry()` / `morseTracer()` — send the Vercel AI SDK's OWN
 * OpenTelemetry spans to Morse (MHQ-1216), as an alternative to the traced
 * replacement functions from `createTracedVercelAI()` (which stay as they are).
 *
 * How the AI SDK emits spans in v7
 * --------------------------------
 * `ai@7` core no longer talks to OpenTelemetry. Telemetry is a pluggable
 * `Telemetry` integration, and the OpenTelemetry ones ship in `@ai-sdk/otel`:
 * `LegacyOpenTelemetry` (the `ai.generateText` / `ai.generateText.doGenerate`
 * / `ai.toolCall` span names and `ai.*` attributes) and `OpenTelemetry` (the
 * GenAI-semconv `invoke_agent` / `chat` / `execute_tool` names). Both accept a
 * `tracer`. The pre-v7 `experimental_telemetry: { tracer }` option is GONE
 * from core — passing a tracer there does nothing on v7 — so the tracer has to
 * be handed to the integration. That is what `morseTelemetry()` does.
 *
 * Why a tracer from Morse's private provider, not the global one
 * ---------------------------------------------------------------
 * The SDK's `NodeTracerProvider` is deliberately never `register()`ed (it
 * would hijack the host app's OTel setup — see `_internal/otel-provider.ts`).
 * Spans started from `engine.getTracer()` still flow through the engine's
 * sampler -> BatchSpanProcessor -> RedactingSpanExporter -> OTLP exporter to
 * `/api/v1/otlp/v1/traces`; an app's own provider (Datadog, Sentry, ...) is
 * untouched and does not see these spans.
 *
 * What the engine applies to these spans
 * --------------------------------------
 *  - Sampling: `ParentBased(TraceIdRatioBased(MORSE_SAMPLE_RATE))`. A root AI
 *    SDK span is sampled by trace id; its children follow it. Inside
 *    `morse.run()` the parent is Morse's synthetic span context, whose
 *    sampled flag came from the same ratio, so the decision is shared.
 *  - Redaction: the exporter-level redaction (default-on secret/PII patterns,
 *    `init({ redaction })`) runs over every string attribute, including
 *    `ai.prompt*` / `ai.response.*`.
 *  - Resource: the SDK resource carries NO `service.name` (MHQ-1100), so
 *    Morse's ingest cannot take an agent name from it. When `functionId` is
 *    given, the tracer stamps `morse.agent` on a span that has no parent.
 *    Inside `morse.run("name", ...)` the Morse root already owns the agent
 *    name and the AI SDK spans nest under it (same trace id).
 *  - Context: needs a context manager so the AI SDK's `executeTool` /
 *    `executeLanguageModelCall` nest correctly; `engine.getTracer()` installs
 *    the SDK's async-hooks one (a no-op if the host already registered one).
 */

import {
  context as otelContext,
  INVALID_SPAN_CONTEXT,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";

import { getEngine, isOtelAvailable } from "../_internal/otel-provider";

/** Metadata values the AI SDK has always accepted (`experimental_telemetry.metadata`). */
export type MorseTelemetryMetadata = Record<string, string | number | boolean>;

/** Attribute prefix the AI SDK used for `experimental_telemetry.metadata` entries. */
const METADATA_PREFIX = "ai.telemetry.metadata.";

/** A `Telemetry` integration class from `@ai-sdk/otel` (`LegacyOpenTelemetry` / `OpenTelemetry`). */
export type TelemetryIntegrationClass<I extends object> = new (options: { tracer: Tracer }) => I;

export interface MorseTracerOptions {
  /**
   * Extra metadata stamped on every span as `ai.telemetry.metadata.<key>` —
   * the attribute the AI SDK's own `metadata` option produced before v7.
   * Non-primitive values are dropped.
   */
  metadata?: MorseTelemetryMetadata;
  /** Conversation / session id; stamped as `ai.telemetry.metadata.thread_id`. */
  threadId?: string;
  /** End-user id; stamped as `ai.telemetry.metadata.user_id`. */
  userId?: string;
  /**
   * Names the agent for spans with no parent (`morse.agent`). Usually the
   * same string as `functionId`.
   */
  agentName?: string;
}

export interface MorseTelemetryOptions<I extends object> extends MorseTracerOptions {
  /**
   * The integration class to instantiate with Morse's tracer: pass
   * `LegacyOpenTelemetry` (or `OpenTelemetry`) from `@ai-sdk/otel`. The SDK
   * cannot import it for you — `@ai-sdk/otel` is an optional peer dependency.
   */
  integration: TelemetryIntegrationClass<I>;
  /**
   * The AI SDK's `functionId`: groups spans per call site, emitted as
   * `ai.telemetry.functionId`, and used as the agent name for a span with no
   * parent.
   */
  functionId?: string;
  /** Record prompts/inputs on the spans (AI SDK default: true). */
  recordInputs?: boolean;
  /** Record responses/outputs on the spans (AI SDK default: true). */
  recordOutputs?: boolean;
}

/**
 * The object to pass as `telemetry` (or `experimental_telemetry`) to
 * `generateText` / `streamText` / `ToolLoopAgent` and friends. Structurally a
 * subset of `ai`'s `TelemetryOptions`.
 */
export interface MorseTelemetrySettings<I extends object = object> {
  isEnabled: boolean;
  functionId?: string;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  /** Per-call integration; takes precedence over any globally registered one. */
  integrations?: [I];
}

/* ------------------------------------------------------------------------ */
/*  One-time warning (same latch pattern as tracing.ts::startSpan, MHQ-806)   */
/* ------------------------------------------------------------------------ */

let warningEmitted = false;

/** Test hook — clears the once-per-process latch. */
export function _resetMorseTelemetryWarning(): void {
  warningEmitted = false;
}

function warnOnce(message: string): void {
  if (warningEmitted) return;
  warningEmitted = true;
  try {
    console.warn(`morse: ${message} This warning prints once per process.`);
  } catch {
    // A console-less runtime is not a reason to fail the customer's call.
  }
}

function unavailableReason(): string {
  return isOtelAvailable()
    ? "Morse is not initialised, so AI SDK telemetry is switched off for this call — call " +
        "morse.init({ apiKey }) (or set MORSE_API_KEY and run it once) before the first AI SDK call."
    : "this is the browser build, where the OTLP span pipeline does not exist, so AI SDK " +
        "telemetry is switched off — use morseTelemetry() in server-side code.";
}

/* ------------------------------------------------------------------------ */
/*  Scoped tracer                                                            */
/* ------------------------------------------------------------------------ */

function isAttributeValue(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
  );
}

function buildExtraAttributes(opts: MorseTracerOptions): Attributes {
  const attrs: Attributes = {};
  for (const [key, value] of Object.entries(opts.metadata ?? {})) {
    if (isAttributeValue(value)) attrs[`${METADATA_PREFIX}${key}`] = value;
  }
  if (opts.threadId) attrs[`${METADATA_PREFIX}thread_id`] = opts.threadId;
  if (opts.userId) attrs[`${METADATA_PREFIX}user_id`] = opts.userId;
  return attrs;
}

function hasValidParent(ctx: Context): boolean {
  const parent = trace.getSpan(ctx)?.spanContext();
  return parent !== undefined && trace.isSpanContextValid(parent);
}

/**
 * A `Tracer` that resolves the engine's tracer on every call (so a second
 * `init()` — which tears down the previous provider — never leaves the AI SDK
 * holding a dead one) and stamps the per-call attributes. Before `init()` it
 * returns non-recording spans and says so once.
 */
class MorseScopedTracer implements Tracer {
  constructor(
    private readonly extra: Attributes,
    private readonly agentName: string | undefined,
  ) {}

  startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
    const base = getEngine().getTracer();
    if (base === null) {
      warnOnce(`AI SDK span ${JSON.stringify(name)} was dropped — ${unavailableReason()}`);
      return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    }
    const parentCtx = ctx ?? otelContext.active();
    const attributes: Attributes = { ...this.extra };
    if (this.agentName && !hasValidParent(parentCtx)) attributes["morse.agent"] = this.agentName;
    Object.assign(attributes, options?.attributes);
    return base.startSpan(name, { ...options, attributes }, ctx);
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    ctx: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    arg2: SpanOptions | F,
    arg3?: Context | F,
    arg4?: F,
  ): ReturnType<F> {
    let options: SpanOptions | undefined;
    let ctx: Context | undefined;
    let fn: F;
    if (typeof arg2 === "function") {
      fn = arg2;
    } else if (typeof arg3 === "function") {
      options = arg2;
      fn = arg3;
    } else {
      options = arg2;
      ctx = arg3;
      fn = arg4 as F;
    }
    const parent = ctx ?? otelContext.active();
    const span = this.startSpan(name, options, parent);
    return otelContext.with(
      trace.setSpan(parent, span),
      fn as (s: Span) => ReturnType<F>,
      undefined,
      span,
    );
  }
}

/* ------------------------------------------------------------------------ */
/*  Public API                                                               */
/* ------------------------------------------------------------------------ */

/**
 * A `Tracer` that records into Morse's pipeline, for anything that accepts
 * one: `new LegacyOpenTelemetry({ tracer: morseTracer() })`, or the pre-v7
 * `experimental_telemetry: { isEnabled: true, tracer: morseTracer() }`.
 *
 * Safe to create before `morse.init()` (it looks the engine up per span); until
 * `init()` runs its spans are non-recording and a single warning is printed.
 * Never throws.
 */
export function morseTracer(options: MorseTracerOptions = {}): Tracer {
  return new MorseScopedTracer(buildExtraAttributes(options), options.agentName);
}

/**
 * Settings for the AI SDK's own telemetry that route its OpenTelemetry spans
 * to Morse — use it where you would otherwise pass `telemetry`:
 *
 * ```ts
 * import { generateText } from "ai";
 * import { LegacyOpenTelemetry } from "@ai-sdk/otel";
 * import { morseTelemetry } from "@morsehq-dev/sdk/vercel-ai";
 *
 * await generateText({
 *   model,
 *   prompt,
 *   telemetry: morseTelemetry({
 *     integration: LegacyOpenTelemetry, // or OpenTelemetry
 *     functionId: "support-agent",
 *     threadId,
 *   }),
 * });
 * ```
 *
 * Requires `morse.init(...)` to have run. If it has not (or in the browser
 * build) this returns `{ isEnabled: false }` — the AI SDK then records
 * nothing for the call — and prints one warning per process. It never throws.
 *
 * The integration is created per call and passed as `integrations`, which the
 * AI SDK prefers over a globally registered one, so a `registerTelemetry()`
 * elsewhere in the app is not duplicated. Spans carry `ai.telemetry.functionId`
 * and `ai.telemetry.metadata.*` (including `thread_id` / `user_id`). See the
 * module doc for how sampling, redaction and the resource apply.
 *
 * `createTracedVercelAI()` is unchanged and remains the way to get Morse's
 * typed `agent` / `llm` spans without any OTel integration.
 */
export function morseTelemetry<I extends object>(
  options: MorseTelemetryOptions<I>,
): MorseTelemetrySettings<I> | { isEnabled: false } {
  try {
    if (getEngine().getTracer() === null) {
      warnOnce(`morseTelemetry() returned { isEnabled: false } — ${unavailableReason()}`);
      return { isEnabled: false };
    }
    if (typeof options?.integration !== "function") {
      warnOnce(
        "morseTelemetry() needs { integration } — pass LegacyOpenTelemetry (or OpenTelemetry) from " +
          '"@ai-sdk/otel", which the AI SDK v7 requires to emit OpenTelemetry spans — so telemetry ' +
          "is switched off for this call.",
      );
      return { isEnabled: false };
    }
    const tracer = morseTracer({
      metadata: options.metadata,
      threadId: options.threadId,
      userId: options.userId,
      agentName: options.agentName ?? options.functionId,
    });
    const settings: MorseTelemetrySettings<I> = {
      isEnabled: true,
      integrations: [new options.integration({ tracer })],
    };
    if (options.functionId !== undefined) settings.functionId = options.functionId;
    if (options.recordInputs !== undefined) settings.recordInputs = options.recordInputs;
    if (options.recordOutputs !== undefined) settings.recordOutputs = options.recordOutputs;
    return settings;
  } catch {
    // Non-invasive guarantee: a telemetry helper must never break the AI call.
    return { isEnabled: false };
  }
}
