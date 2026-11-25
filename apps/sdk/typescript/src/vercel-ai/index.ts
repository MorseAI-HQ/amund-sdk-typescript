/**
 * `@amund/sdk/vercel-ai` — Vercel AI SDK instrumentation.
 *
 * Mirrors the Python adapters' contract from
 * `openspec/changes/phase-6c-multi-sdk-dogfood/specs/sdk/spec.md`:
 *
 *   - One `agent` span per top-level `streamText` / `generateText` /
 *     `generateObject` invocation.
 *   - One `llm` child span per LLM round trip.
 *   - One `tool` child span per tool invocation.
 *   - Multi-step `maxSteps` runs render as ONE `agent` span with
 *     N `llm` + tool children.
 *   - W3C `traceparent` header injected on outbound `fetch` so the
 *     Copilot frontend → backend flow renders as one unified trace.
 *   - Client-side `useChat` calls emit a parent client-side span, then
 *     inject the W3C context onto the resulting fetch.
 *
 * MHQ-758: earlier versions of this adapter instrumented `ai` by
 * reassigning its named exports in place (`aiModule.streamText = wrapped`).
 * That only works against a plain mutable object — real installs of `ai`
 * are pure ESM, and Node exposes ESM named exports as non-configurable
 * getter-only properties on the CJS interop namespace too, so the
 * assignment throws `TypeError: ... which has only a getter`, silently
 * swallowed by `absorbErrorsAsync`. Confirmed via a bare Node repro
 * (no bundler involved) during MHQ-482 OSS dogfooding — see
 * `bizops/dogfood/ai-sdk-preview-rag.md`. `ai`'s functions have no
 * prototype to patch either (unlike `@anthropic-ai/sdk`'s
 * `Messages.prototype.create`), so there is no way to instrument the
 * real module in place.
 *
 * Fix: `createTracedVercelAI()` resolves the real `ai` module once and
 * returns traced *replacement* functions the customer imports and calls
 * instead of `ai`'s own — no mutation, works under any module system.
 * This means `ai` cannot be zero-config auto-detected (there is nothing
 * to silently patch); it's a `DETECT_ONLY_TARGETS` entry in
 * `_internal/auto-detect.ts` that points here.
 *
 * MHQ-1216: the other route. `morseTelemetry()` / `morseTracer()` (see
 * `./telemetry.ts`) send the AI SDK's OWN OpenTelemetry spans to Morse, so
 * `generateText` etc. keep being imported from `ai` untouched. The two routes
 * are independent; do not enable both for the same call or it is recorded twice.
 *
 * MHQ-750: Python has no Vercel AI equivalent to mirror (it doesn't exist
 * as a Python package), so `context_segments` support here is a TS-only
 * extension. It's wired in because the Vercel AI SDK's `CoreMessage[]`
 * `messages` param is already OpenAI-chat-format-compatible
 * (`{role, content}`), so the shared `_agent-sdk-common/context-decomposer`
 * applies directly — no translation layer beyond converting the SDK's
 * `tools: Record<name, Tool>` shape into the OpenAI `tools` array shape
 * the decomposer expects (see `toolsRecordToArray` below).
 */

import {
  getActiveTraceState,
  holdTraceOpen,
  runAsync as _runAsync,
  startDetachedSpan,
} from "../_internal/tracing";
import { calculateCost } from "../_internal/pricing";
import { injectTraceparent, prepareLlmCall, propagationEnabled } from "../propagation";
import { decomposeOpenAiMessages } from "../_agent-sdk-common/context-decomposer";
import { emitLlmSpan } from "../_agent-sdk-common/span-emitter";
import { captureInputMessages, truncateText } from "../_internal/llm-io";

export { morseTelemetry, morseTracer } from "./telemetry";
export type {
  MorseTelemetryMetadata,
  MorseTelemetryOptions,
  MorseTelemetrySettings,
  MorseTracerOptions,
  TelemetryIntegrationClass,
} from "./telemetry";

const ADAPTER = "vercel-ai" as const;

/* ------------------------------------------------------------------------ */
/*  Configuration                                                            */
/* ------------------------------------------------------------------------ */

export interface InstrumentVercelAIOptions {
  /**
   * The Vercel AI module to instrument. If omitted, the adapter
   * imports `ai` lazily — recommended for server-side usage.
   *
   * Pass an explicit module when you have a constraint that prevents
   * dynamic import (older bundlers, strict tree-shaking, etc.).
   */
  aiModule?: unknown;
  /**
   * If true, also patch `globalThis.fetch` so outbound HTTP requests
   * inside an active trace context automatically carry a `traceparent`
   * header. Default: true on the browser (where `useChat` lives),
   * false on the server.
   */
  patchGlobalFetch?: boolean;
  /**
   * When provided, used as the parent agent span's name. Default:
   * `"vercel-ai.<primitive>"` (e.g., `"vercel-ai.streamText"`).
   */
  defaultAgentName?: string;
  /**
   * Default `true` (MHQ-1880). Calls made inside an active trace pass a W3C
   * `traceparent` in the call's `headers` option, naming the `llm` span, so a gateway
   * that forwards it joins the trace. A `traceparent` you set is never replaced.
   * `false` sends nothing; `AMUND_PROPAGATE_TRACE_CONTEXT=false` does the same globally.
   */
  propagateTraceContext?: boolean;
}

/** The traced replacement functions returned by {@link createTracedVercelAI}. */
export interface TracedVercelAI {
  streamText: (...args: unknown[]) => unknown;
  generateText: (...args: unknown[]) => unknown;
  generateObject: (...args: unknown[]) => unknown;
}

/* ------------------------------------------------------------------------ */
/*  Public API                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Resolve the real `ai` module once and return traced replacements for
 * `streamText` / `generateText` / `generateObject` — import and call these
 * in place of `ai`'s own exports (`ai`'s named exports can't be patched
 * in place; see the module doc comment above).
 *
 * ```ts
 * import { createTracedVercelAI } from "@amund/sdk/vercel-ai";
 * const { streamText } = await createTracedVercelAI();
 * // use streamText(...) exactly like ai's own streamText(...)
 * ```
 *
 * Throws if `ai` can't be resolved (not installed, or a module system that
 * blocks dynamic `import()`) — surfaced at setup time rather than silently
 * leaving calls untraced.
 */
export async function createTracedVercelAI(
  options: InstrumentVercelAIOptions = {},
): Promise<TracedVercelAI> {
  const aiModule = await loadAiModule(options.aiModule);
  if (!aiModule || typeof aiModule !== "object") {
    throw new Error(
      'morse: createTracedVercelAI() could not resolve the "ai" package — is it installed? ' +
        "Pass { aiModule } explicitly if your bundler blocks dynamic import().",
    );
  }
  const mod = aiModule as Record<string, unknown>;

  const shouldPatchFetch = options.patchGlobalFetch ?? isBrowser();
  if (shouldPatchFetch && typeof globalThis.fetch === "function") {
    globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis));
  }

  const original = {
    streamText: mod.streamText as (...args: unknown[]) => unknown,
    generateText: mod.generateText as (...args: unknown[]) => unknown,
    generateObject: mod.generateObject as (...args: unknown[]) => unknown,
  };
  if (typeof original.streamText !== "function" || typeof original.generateText !== "function") {
    throw new Error(
      'morse: the resolved "ai" module is missing streamText/generateText — ' +
        "unexpected shape, is this really the Vercel AI SDK's `ai` package?",
    );
  }

  return {
    streamText: wrapStreamText(original.streamText, options),
    generateText: wrapGenerate(original.generateText, "vercel-ai.generateText", options),
    generateObject:
      typeof original.generateObject === "function"
        ? wrapGenerate(original.generateObject, "vercel-ai.generateObject", options)
        : original.generateObject,
  };
}

/* ------------------------------------------------------------------------ */
/*  Internal: lazy import of `ai`                                            */
/* ------------------------------------------------------------------------ */

async function loadAiModule(explicit?: unknown): Promise<unknown | null> {
  if (explicit && typeof explicit === "object") return explicit;
  try {
    // Dynamic import — gracefully no-ops if the customer doesn't depend on `ai`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (Function("m", "return import(m)") as any)("ai");
  } catch {
    return null;
  }
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/* ------------------------------------------------------------------------ */
/*  Wrappers                                                                 */
/* ------------------------------------------------------------------------ */

interface CallArgs {
  model?: { provider?: string; modelId?: string; id?: string };
  maxSteps?: number;
  tools?: Record<string, unknown>;
  messages?: unknown;
  prompt?: unknown;
  system?: unknown;
}

function modelLabel(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as CallArgs;
  const m = a.model;
  if (!m || typeof m !== "object") return undefined;
  return m.modelId ?? m.id ?? m.provider;
}

/**
 * Convert the Vercel AI SDK's `tools: Record<toolName, Tool>` shape into
 * the OpenAI `tools: [{type:"function", function:{name, ...}}]` array
 * shape the shared decomposer expects. Best-effort — never throws.
 */
function toolsRecordToArray(tools: Record<string, unknown> | undefined): unknown[] | undefined {
  if (!tools || typeof tools !== "object") return undefined;
  const entries = Object.entries(tools);
  if (entries.length === 0) return undefined;
  return entries.map(([name, def]) => ({
    type: "function",
    function: { name, ...(def && typeof def === "object" ? def : {}) },
  }));
}

/** Compute `context_segments` from a Vercel AI SDK call's `messages`/`tools`, if present. */
function contextSegmentsFor(args: CallArgs): ReturnType<typeof decomposeOpenAiMessages> {
  return decomposeOpenAiMessages(args.messages, toolsRecordToArray(args.tools));
}

/**
 * MHQ-1156: `input_data` for a Vercel AI call, via the same shared helper
 * the `/openai` adapter uses. `messages` is already `{role, content}`-shaped;
 * a bare `prompt` string is the single-user-message shorthand.
 */
function inputDataFor(args: CallArgs): unknown {
  const messages =
    Array.isArray(args.messages) && args.messages.length > 0
      ? args.messages
      : typeof args.prompt === "string" && args.prompt.length > 0
        ? [{ role: "user", content: args.prompt }]
        : undefined;
  return captureInputMessages(messages, args.system);
}

/**
 * MHQ-1156: `output_data` from a resolved result — `text` for
 * `generateText`/`streamText`, `object` for `generateObject`.
 */
function applyOutput(handle: FinalizeHandle, text: unknown, object?: unknown): void {
  let out: string | undefined;
  if (typeof text === "string" && text.length > 0) {
    out = text;
  } else if (object !== undefined && object !== null) {
    try {
      out = JSON.stringify(object);
    } catch {
      out = undefined;
    }
  }
  if (out) handle.span.output_data = { content: truncateText(out) };
}

/**
 * MHQ-1880: `args` with `headers.traceparent` added to the first (options) argument,
 * naming `spanId`. The caller's options object is copied, never mutated; returns
 * `args` itself when nothing is added.
 */
function argsWithTraceparent(
  args: unknown[],
  spanId: string | undefined,
  propagate: boolean,
): unknown[] {
  try {
    const first = args[0];
    if (!first || typeof first !== "object") return args;
    const base = { headers: (first as { headers?: unknown }).headers };
    const prepared = prepareLlmCall(base, spanId, propagate) as { headers?: unknown };
    if (prepared === base) return args;
    return [{ ...(first as object), headers: prepared.headers }, ...args.slice(1)];
  } catch {
    return args;
  }
}

/**
 * Wrap `streamText`. Vercel's `streamText` returns synchronously with
 * a result object whose properties are streams / promises (`textStream`,
 * `text`, `usage`, `finishReason`, etc.). We start the llm span when
 * the function is called and finalize it when `result.usage` (and `text`)
 * resolve.
 *
 * MHQ-1407: the trace stays open until that finalisation. Without an
 * enclosing trace the wrapper opens one and closes it only after the llm span
 * ended (it used to close it as soon as `usage` resolved, before the span's own
 * finalisation ran, so on ai@7 the trace was sent with the agent span alone).
 * Inside `run()` the stream's completion is registered with `holdTraceOpen`,
 * so a route that returns `result.toUIMessageStreamResponse()` keeps its trace
 * (and the spans the stream's tools make) until the stream is done. A stream
 * that fails marks the auto-opened trace failed with `success: false`.
 */
function wrapStreamText(
  original: (...args: unknown[]) => unknown,
  options: InstrumentVercelAIOptions,
): (...args: unknown[]) => unknown {
  const agentName = options.defaultAgentName;
  const propagate = options.propagateTraceContext !== false;

  return function patchedStreamText(...args: unknown[]): unknown {
    // If we're already inside a trace, just emit a child llm span and
    // delegate. Otherwise, open a fresh agent span via runAsync.
    const inTrace = getActiveTraceState() !== null;

    const callArgs = (args[0] ?? {}) as CallArgs;
    const model = modelLabel(callArgs);

    const openLlmSpan = (): FinalizeHandle | null => {
      const handle = emitLlmSpan({
        adapter: ADAPTER,
        model: model ?? "unknown",
        attributes: { max_steps: callArgs.maxSteps ?? 1 },
        inputData: inputDataFor(callArgs),
      });
      if (handle !== null) {
        const contextSegments = contextSegmentsFor(callArgs);
        if (contextSegments.length > 0) handle.span.context_segments = contextSegments;
      }
      return handle;
    };

    if (inTrace) {
      const handle = openLlmSpan();
      try {
        const result = original(...argsWithTraceparent(args, handle?.span.span_id, propagate));
        const release = holdTraceOpen();
        void attachStreamingFinalize(result, handle).then(() => release?.());
        return result;
      } catch (err) {
        handle?.end(err);
        throw err;
      }
    }

    // No active trace — wrap in a fresh agent span. The callback runs
    // synchronously up to its first `await`, so `result` / `syncError` are set
    // before `_runAsync` returns.
    let result: unknown;
    let syncError: unknown;
    let threw = false;
    void _runAsync({ agentName }, async (runHandle) => {
      const handle = openLlmSpan();
      try {
        result = original(...argsWithTraceparent(args, handle?.span.span_id, propagate));
      } catch (err) {
        handle?.end(err);
        threw = true;
        syncError = err;
        throw err;
      }
      const streamError = await attachStreamingFinalize(result, handle);
      if (streamError !== undefined) {
        runHandle.setOutcome(false);
        throw streamError;
      }
      runHandle.setOutcome(true);
      return null;
    }).catch(() => undefined);
    if (threw) throw syncError;
    return result;
  };
}

interface FinalizeHandle {
  span: {
    span_id?: string;
    model?: string;
    context_segments?: unknown;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
    output_data?: unknown;
  };
  end(error?: unknown): void;
}

/**
 * MHQ-789: apply resolved usage to the TOP-LEVEL span fields the dashboard
 * reads (`span.input_tokens`/`.output_tokens`/`.total_tokens`), not
 * `span.metadata` — and compute `cost_usd` the same way every sibling
 * adapter does, once real tokens + a real model are both on the span.
 */
function applyUsage(handle: FinalizeHandle, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const input = u.promptTokens ?? u.inputTokens;
  const output = u.completionTokens ?? u.outputTokens;
  const total = u.totalTokens;
  if (typeof input === "number" && Number.isFinite(input)) handle.span.input_tokens = input;
  if (typeof output === "number" && Number.isFinite(output)) handle.span.output_tokens = output;
  if (typeof total === "number" && Number.isFinite(total)) {
    handle.span.total_tokens = total;
  } else if (handle.span.input_tokens !== undefined && handle.span.output_tokens !== undefined) {
    handle.span.total_tokens = handle.span.input_tokens + handle.span.output_tokens;
  }
  if (
    handle.span.cost_usd === undefined &&
    handle.span.model &&
    handle.span.model !== "unknown" &&
    (handle.span.input_tokens !== undefined || handle.span.output_tokens !== undefined)
  ) {
    const cost = calculateCost({
      inputTokens: handle.span.input_tokens ?? 0,
      outputTokens: handle.span.output_tokens ?? 0,
      model: handle.span.model,
    });
    if (cost !== undefined) handle.span.cost_usd = cost;
  }
}

/**
 * Finalize the llm span when the stream's `usage` (and `text`) resolve.
 * Resolves (never rejects) once the span has ended, with the stream's error
 * if it failed. Also records one `tool` span per tool result in `steps`.
 */
function attachStreamingFinalize(result: unknown, handle: FinalizeHandle | null): Promise<unknown> {
  if (!result || typeof result !== "object") {
    handle?.end();
    return Promise.resolve(undefined);
  }
  const r = result as Record<string, unknown>;
  // The Vercel AI SDK exposes a `usage` Promise that resolves with the
  // token counts at the end of the stream (ai@7: `totalUsage`).
  const usagePromise = r.usage;
  if (!usagePromise || typeof (usagePromise as Promise<unknown>).then !== "function") {
    // No usage — best effort: end the span immediately. The customer
    // may consume the stream afterward; that's fine.
    handle?.end();
    return Promise.resolve(undefined);
  }
  if (!handle) {
    return (usagePromise as Promise<unknown>).then(
      () => undefined,
      (err: unknown) => err,
    );
  }
  // `text` resolves alongside `usage` at stream end; a rejected `text`
  // must not fail the span — the customer surfaces that themselves. Read each
  // getter ONCE: on ai@7 every `result.text` access builds a new promise chain,
  // and one we only inspected (never `.catch`ed) became an unhandled rejection
  // when the stream failed.
  const textPromise = caughtOrUndefined(r.text);
  const stepsPromise = caughtOrUndefined(r.steps);
  return Promise.all([usagePromise as Promise<unknown>, textPromise, stepsPromise]).then(
    ([usage, text, steps]) => {
      applyUsage(handle, usage);
      applyOutput(handle, text);
      emitToolSpans(steps);
      handle.end();
      return undefined;
    },
    (err: unknown) => {
      handle.end(err);
      return err;
    },
  );
}

function caughtOrUndefined(value: unknown): Promise<unknown> {
  if (value && typeof (value as Promise<unknown>).then === "function") {
    return Promise.resolve(value as Promise<unknown>).catch(() => undefined);
  }
  return Promise.resolve(undefined);
}

interface StepToolResult {
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
}

/**
 * One `tool` span per tool result the run's steps report. The AI SDK runs the
 * tools inside the stream, so per-tool timing is not observable from here: the
 * spans carry the tool's name, input and output with `metadata.timing =
 * "unknown"`. Best-effort, never throws.
 */
function emitToolSpans(steps: unknown): void {
  try {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      const results = (step as { toolResults?: unknown })?.toolResults;
      if (!Array.isArray(results)) continue;
      for (const raw of results as StepToolResult[]) {
        const name = typeof raw?.toolName === "string" ? raw.toolName : "tool";
        const span = startDetachedSpan({
          name,
          type: "tool",
          metadata: {
            adapter: ADAPTER,
            timing: "unknown",
            ...(typeof raw?.toolCallId === "string" ? { tool_call_id: raw.toolCallId } : {}),
          },
        });
        if (!span) return;
        const input = raw?.input ?? raw?.args;
        const output = raw?.output ?? raw?.result;
        if (input !== undefined) span.span.input_data = { arguments: safeJson(input) };
        if (output !== undefined) span.span.output_data = { content: safeJson(output) };
        span.end();
      }
    }
  } catch {
    // telemetry must never break the caller
  }
}

function safeJson(value: unknown): string {
  try {
    return truncateText(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    return "";
  }
}

/**
 * Wrap `generateText` / `generateObject`. These return a Promise of a
 * full result; tracing is straightforward.
 */
function wrapGenerate(
  original: (...args: unknown[]) => unknown,
  spanName: string,
  options: InstrumentVercelAIOptions,
): (...args: unknown[]) => unknown {
  const agentName = options.defaultAgentName;
  const propagate = options.propagateTraceContext !== false;

  return function patched(...args: unknown[]): unknown {
    const callArgs = (args[0] ?? {}) as CallArgs;
    const model = modelLabel(callArgs);
    const inTrace = getActiveTraceState() !== null;

    const work = async (): Promise<unknown> => {
      const handle = emitLlmSpan({
        adapter: ADAPTER,
        model: model ?? "unknown",
        attributes: { max_steps: callArgs.maxSteps ?? 1 },
        inputData: inputDataFor(callArgs),
      });
      if (handle !== null) {
        const contextSegments = contextSegmentsFor(callArgs);
        if (contextSegments.length > 0) handle.span.context_segments = contextSegments;
      }
      try {
        const result = await (original(
          ...argsWithTraceparent(args, handle?.span.span_id, propagate),
        ) as Promise<unknown>);
        if (result && typeof result === "object" && handle) {
          const r = result as Record<string, unknown>;
          applyUsage(handle, r.usage);
          applyOutput(handle, r.text, r.object);
        }
        handle?.end();
        return result;
      } catch (err) {
        handle?.end(err);
        throw err;
      }
    };

    if (inTrace) {
      return work();
    }
    return _runAsync({ agentName }, async (runHandle) => {
      runHandle.setOutcome(true);
      return work();
    });
  };
}

/**
 * Wrap `globalThis.fetch` so outbound calls inside an active trace
 * carry a `traceparent` header. The wrapper is idempotent.
 */
function wrapFetch(original: typeof globalThis.fetch): typeof globalThis.fetch {
  const patched: typeof globalThis.fetch = function patched(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) {
    const state = getActiveTraceState();
    if (state === null) {
      return original(input, init);
    }
    try {
      const merged = new Headers(init?.headers ?? {});
      // MHQ-1880: opt-out applies here too, and a caller's own header is kept.
      if (!propagationEnabled() || merged.has("traceparent")) return original(input, init);
      injectTraceparent(merged);
      const next = { ...(init ?? {}), headers: merged };
      return original(input, next);
    } catch {
      return original(input, init);
    }
  };
  return patched;
}
