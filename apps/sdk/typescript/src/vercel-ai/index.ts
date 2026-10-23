/**
 * `@morsehq-dev/sdk/vercel-ai` — Vercel AI SDK instrumentation.
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

import { getActiveTraceState, runAsync as _runAsync } from "../_internal/tracing";
import { calculateCost } from "../_internal/pricing";
import { injectTraceparent } from "../propagation";
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
 * import { createTracedVercelAI } from "@morsehq-dev/sdk/vercel-ai";
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
 * Wrap `streamText`. Vercel's `streamText` returns synchronously with
 * a result object whose properties are streams / promises (`textStream`,
 * `text`, `usage`, `finishReason`, etc.). We start the agent span when
 * the function is called and finalize it when `result.usage` (or one of
 * its terminal promises) resolves.
 */
function wrapStreamText(
  original: (...args: unknown[]) => unknown,
  options: InstrumentVercelAIOptions,
): (...args: unknown[]) => unknown {
  const agentName = options.defaultAgentName;

  return function patchedStreamText(...args: unknown[]): unknown {
    // If we're already inside a trace, just emit a child llm span and
    // delegate. Otherwise, open a fresh agent span via runAsync.
    const inTrace = getActiveTraceState() !== null;

    const callArgs = (args[0] ?? {}) as CallArgs;
    const model = modelLabel(callArgs);

    if (inTrace) {
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
        const result = original(...args);
        attachStreamingFinalize(result, handle);
        return result;
      } catch (err) {
        handle?.end(err);
        throw err;
      }
    }

    // No active trace — wrap in a fresh agent span.
    let result: unknown;
    void _runAsync({ agentName }, async (runHandle) => {
      runHandle.setOutcome(true);
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
        result = original(...args);
        attachStreamingFinalize(result, handle);
        // Wait for completion (best-effort) so the agent span ends after
        // the LLM span — without consuming the user's stream.
        await waitForStreamCompletion(result);
      } catch (err) {
        handle?.end(err);
        throw err;
      }
      return null;
    });
    return result;
  };
}

interface FinalizeHandle {
  span: {
    model?: string;
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

function attachStreamingFinalize(result: unknown, handle: FinalizeHandle | null): void {
  if (!handle) return;
  if (!result || typeof result !== "object") {
    handle.end();
    return;
  }
  const r = result as Record<string, unknown>;
  // The Vercel AI SDK exposes a `usage` Promise that resolves with the
  // token counts at the end of the stream. If unavailable, fall back to
  // a `finalize` Promise we wait on.
  const usagePromise = r.usage;
  if (usagePromise && typeof (usagePromise as Promise<unknown>).then === "function") {
    // `text` resolves alongside `usage` at stream end; a rejected `text`
    // must not fail the span — the customer surfaces that themselves.
    const textPromise =
      r.text && typeof (r.text as Promise<unknown>).then === "function"
        ? (r.text as Promise<unknown>).catch(() => undefined)
        : Promise.resolve(undefined);
    void Promise.all([usagePromise as Promise<unknown>, textPromise])
      .then(([usage, text]) => {
        applyUsage(handle, usage);
        applyOutput(handle, text);
        handle.end();
      })
      .catch((err) => handle.end(err));
    return;
  }
  // No usage — best effort: end the span immediately. The customer
  // may consume the stream afterward; that's fine.
  handle.end();
}

async function waitForStreamCompletion(result: unknown): Promise<void> {
  if (!result || typeof result !== "object") return;
  const r = result as Record<string, unknown>;
  const candidates = ["usage", "finishReason", "text"];
  for (const key of candidates) {
    const v = r[key];
    if (v && typeof (v as Promise<unknown>).then === "function") {
      try {
        await v;
      } catch {
        // swallow — the customer will surface the error via their own consumption
      }
      return;
    }
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
        const result = await (original(...args) as Promise<unknown>);
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
      injectTraceparent(merged);
      const next = { ...(init ?? {}), headers: merged };
      return original(input, next);
    } catch {
      return original(input, init);
    }
  };
  return patched;
}
