/**
 * `@morsehq-dev/sdk/openai` — plain OpenAI SDK instrumentation.
 *
 * Wraps a raw `openai` npm package client (`new OpenAI()` /
 * `new AzureOpenAI()` / any structurally-compatible client) so every
 * `chat.completions.create` call emits an `llm` span carrying model,
 * token counts, `cost_usd`, and pre-segmented `context_segments`.
 *
 * TS port of `apps/sdk/python/src/morse_ai/adapters/openai.py`'s `wrap()`.
 * This module intentionally covers only the `wrap(client)` recommended
 * path (mirrors the Python module's three-layer doc comment, layer 2) —
 * no module-level monkey-patch / `install()` layer, since plain `openai`
 * is not one of the auto-detect targets on either SDK (see
 * `_internal/auto-detect.ts` and Python's `_internal/auto_detect.py`
 * `_adapter_targets()`, which both omit bare `openai`).
 *
 * Distinct from `@morsehq-dev/sdk/openai-agents`, which instruments the
 * `@openai/agents` Agents SDK (a different package with its own Runner /
 * Agent abstractions). This module is for customers calling
 * `openai.chat.completions.create` directly.
 *
 * Context segments are extracted via the shared
 * `_agent-sdk-common/context-decomposer.ts` (`decomposeOpenAiMessages`,
 * MHQ-750) — the request's `messages`/`tools` are already in the native
 * OpenAI wire format the decomposer expects, so no translation layer is
 * needed.
 *
 * Idempotent — wrapping an already-wrapped client instance is a no-op
 * that returns the same wrapper. Recording is best-effort: any failure
 * while building/emitting the span is swallowed so it can never break the
 * customer's OpenAI call. The customer's own API error (thrown by the
 * underlying `create()` call) always propagates unchanged — the span is
 * marked `status: "failed"` first, then the error is re-raised.
 *
 * Mirrors `apps/sdk/typescript/src/anthropic/index.ts` in shape.
 */

import { decomposeOpenAiMessages } from "../_agent-sdk-common/context-decomposer";
import { setActiveFramework } from "../_internal/active-framework";
import { captureInputMessages, extractOpenAiOutputText } from "../_internal/llm-io";
import { calculateCost } from "../_internal/pricing";
import type { ContextSegment } from "../_internal/spans";
import { getActiveTraceState, runAsync as _runAsync, startSpan } from "../_internal/tracing";
import { report } from "../_internal/diagnostics";

/* ------------------------------------------------------------------------ */
/*  Public types — minimal structural shapes, NOT a hard dep on `openai`     */
/* ------------------------------------------------------------------------ */

/** Subset of the `openai` package's chat message shape we read from. */
export interface OpenAiChatMessageParam {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  [key: string]: unknown;
}

/** Subset of the `openai` package's tool-definition shape we read from. */
export interface OpenAiToolParam {
  type?: string;
  function?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Subset of `openai`'s `ChatCompletionCreateParams` we read from. We
 * deliberately decline to import the real types so the SDK works even when
 * `openai` isn't installed (it's an optional peer dep).
 */
export interface OpenAiChatCompletionCreateParams {
  model: string;
  messages: OpenAiChatMessageParam[];
  tools?: OpenAiToolParam[];
  // Allow forward-compat fields without complaint.
  [key: string]: unknown;
}

export interface OpenAiCompletionUsageDetails {
  cached_tokens?: number;
  reasoning_tokens?: number;
  [key: string]: unknown;
}

export interface OpenAiCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: OpenAiCompletionUsageDetails;
  completion_tokens_details?: OpenAiCompletionUsageDetails;
  [key: string]: unknown;
}

export interface OpenAiChatCompletionResponse {
  id?: string;
  model?: string;
  usage?: OpenAiCompletionUsage;
  choices?: Array<{ message?: { content?: unknown; [k: string]: unknown }; [k: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Structural shape of the plain OpenAI client we wrap. We only require
 * that `client.chat.completions.create` is a function returning a Promise.
 */
export interface OpenAiClientLike {
  chat: {
    completions: {
      create(
        params: OpenAiChatCompletionCreateParams,
        options?: unknown,
      ): Promise<OpenAiChatCompletionResponse>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------ */
/*  Module-level sentinel                                                    */
/* ------------------------------------------------------------------------ */

const WRAPPED_CLIENT = Symbol.for("morse.openai.wrapped");

/* ------------------------------------------------------------------------ */
/*  Public API                                                               */
/* ------------------------------------------------------------------------ */

export interface WrapOpenAiOptions {
  /**
   * When provided, used as the parent agent span's name when
   * `chat.completions.create` is called outside an active trace. Defaults
   * to `"openai.chat.completions.create"`.
   */
  defaultAgentName?: string;
}

/**
 * Wrap an OpenAI client so every `chat.completions.create` call records an
 * `llm` span with `model`, token counts, `cost_usd`, and `context_segments`.
 * The wrapper preserves the rest of the client's surface (other resources,
 * helpers, etc.) via a Proxy.
 *
 * Idempotent — a previously wrapped client is returned as-is.
 *
 * @example
 * ```ts
 * import { wrapOpenAI } from "@morsehq-dev/sdk/openai";
 * import OpenAI from "openai";
 *
 * const client = wrapOpenAI(new OpenAI());
 * const response = await client.chat.completions.create({
 *   model: "gpt-4o-mini",
 *   messages: [{ role: "user", content: "hello" }],
 * });
 * ```
 */
export function wrapOpenAI<C extends OpenAiClientLike>(
  client: C,
  options: WrapOpenAiOptions = {},
): C {
  if (!client || typeof client !== "object") return client;
  // Already wrapped? Pass through.
  if ((client as Record<string | symbol, unknown>)[WRAPPED_CLIENT]) return client;

  const originalCreate = client.chat?.completions?.create?.bind(client.chat.completions);
  if (typeof originalCreate !== "function") return client;

  const patchedCreate = buildPatchedCreate(originalCreate, options);

  // Construct a new `completions` object that proxies to the original for
  // any non-`create` access, wrapped in a `chat` proxy, wrapped in a
  // top-level client proxy — mirrors `wrapAnthropic`'s nested-Proxy shape.
  const patchedCompletions = new Proxy(client.chat.completions, {
    get(target, prop, receiver) {
      if (prop === "create") return patchedCreate;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });

  const patchedChat = new Proxy(client.chat, {
    get(target, prop, receiver) {
      if (prop === "completions") return patchedCompletions;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });

  const wrapper = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLIENT) return true;
      if (prop === "chat") return patchedChat;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });

  return wrapper as C;
}

/** True when a wrapped OpenAI client is passed in. */
export function isOpenAiWrapped(client: unknown): boolean {
  if (!client || typeof client !== "object") return false;
  return (client as Record<string | symbol, unknown>)[WRAPPED_CLIENT] === true;
}

/* ------------------------------------------------------------------------ */
/*  Internals — wrapper that records an `llm` span                           */
/* ------------------------------------------------------------------------ */

function buildPatchedCreate(
  original: (
    params: OpenAiChatCompletionCreateParams,
    options?: unknown,
  ) => Promise<OpenAiChatCompletionResponse>,
  options: WrapOpenAiOptions,
): (
  params: OpenAiChatCompletionCreateParams,
  options?: unknown,
) => Promise<OpenAiChatCompletionResponse> {
  const agentName = options.defaultAgentName ?? "openai.chat.completions.create";

  return async function patchedCreate(
    this: unknown,
    params: OpenAiChatCompletionCreateParams,
    callOptions?: unknown,
  ): Promise<OpenAiChatCompletionResponse> {
    const inTrace = getActiveTraceState() !== null;

    const work = async (): Promise<OpenAiChatCompletionResponse> => {
      setActiveFramework("openai");
      const handle = startSpan({
        name: "openai.chat.completions.create",
        type: "llm",
        metadata: { model: params?.model },
      });
      let response: OpenAiChatCompletionResponse | undefined;
      try {
        response = await original.call(this, params, callOptions);
      } catch (err) {
        // Customer's own API error — mark the span failed, then re-raise
        // unchanged. Never swallow the caller's real error.
        handle?.end(err);
        throw err;
      }

      // Recording is best-effort — never let it throw at the caller.
      try {
        if (handle) {
          const segments = safeExtractSegments(params);
          const usage = response?.usage ?? {};
          const inputTokens = usage.prompt_tokens ?? 0;
          const outputTokens = usage.completion_tokens ?? 0;
          const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
          const model = response?.model ?? params?.model;

          handle.span.model = model;
          if (inputTokens > 0) handle.span.input_tokens = inputTokens;
          if (outputTokens > 0) handle.span.output_tokens = outputTokens;
          if (cachedTokens > 0) handle.span.cached_input_tokens = cachedTokens;
          const totalTokens =
            usage.total_tokens ??
            (inputTokens > 0 || outputTokens > 0 ? inputTokens + outputTokens : 0);
          if (totalTokens > 0) handle.span.total_tokens = totalTokens;

          if (model && (inputTokens > 0 || outputTokens > 0)) {
            const cost = calculateCost({
              inputTokens,
              outputTokens,
              model,
              cachedInputTokens: cachedTokens,
            });
            if (cost !== undefined) handle.span.cost_usd = cost;
          }
          handle.span.context_segments = segments;
          // MHQ-858: prompt/response capture, parity with the Python
          // adapter's input_data/output_data.
          const inputData = captureInputMessages(params?.messages);
          if (inputData !== undefined) handle.span.input_data = inputData;
          const outputText = extractOpenAiOutputText(response?.choices);
          if (outputText !== undefined) handle.span.output_data = { content: outputText };
        }
      } catch (err) {
        // swallow — telemetry must never break the caller
        reportSwallowed(err, "morse.openai.stream_wrap");
      }
      handle?.end();
      return response;
    };

    if (inTrace) {
      return work();
    }

    // No active trace — open a fresh agent span around the call so the
    // llm span has a parent. Mirrors `wrapAnthropic`'s pattern: we can't
    // return `work()`'s Promise from inside `_runAsync`'s callback while
    // preserving typing AND having the fresh trace own the lifecycle, so
    // we wrap explicitly.
    let result: OpenAiChatCompletionResponse | undefined;
    let thrown: unknown;
    await _runAsync({ agentName }, async (runHandle) => {
      runHandle.setOutcome(true);
      try {
        result = await work();
      } catch (err) {
        thrown = err;
        throw err;
      }
      return null;
    });
    if (thrown !== undefined) throw thrown;
    return result as OpenAiChatCompletionResponse;
  };
}

function safeExtractSegments(params: OpenAiChatCompletionCreateParams): ContextSegment[] {
  try {
    if (!params || typeof params !== "object") return [];
    return decomposeOpenAiMessages(params.messages, params.tools);
  } catch {
    return [];
  }
}

/**
 * Route a swallowed internal error to the diagnostics channel (SDKDIAG-07).
 *
 * Control flow is unchanged — the site still swallows, still returns the same
 * value. It is simply no longer invisible to us.
 */
function reportSwallowed(err: unknown, fingerprint: string): void {
  try {
    report(err, { fingerprint });
  } catch {
    // Reporting must never break the swallow it is reporting on.
  }
}
