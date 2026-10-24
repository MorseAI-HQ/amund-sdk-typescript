/**
 * `@morsehq-dev/sdk/openai` — plain OpenAI SDK instrumentation.
 *
 * Wraps a raw `openai` npm package client (`new OpenAI()` /
 * `new AzureOpenAI()` / any structurally-compatible client) so every
 * `chat.completions.create` and `responses.create` call emits an `llm`
 * span carrying model, token counts, `cost_usd`, and pre-segmented
 * `context_segments`.
 *
 * Streaming (`stream: true`) is traced on both APIs (MHQ-1407): the span is
 * recorded when the stream ends, from the chunks/events. Chat Completions only
 * reports usage on a stream with `stream_options: { include_usage: true }`;
 * without it the span has the model and output but no tokens
 * (`metadata.usage_unavailable`). `create()` keeps returning the SDK's
 * `APIPromise`, so `.withResponse()` / `.asResponse()` still work.
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
import { captureInputMessages, extractOpenAiOutputText, truncateText } from "../_internal/llm-io";
import { calculateCost } from "../_internal/pricing";
import { mapKeepingShape, onRejected, wrapEventStream } from "../_internal/api-promise";
import { type ContextSegment, nowIso, type SpanData } from "../_internal/spans";
import {
  getActiveTraceState,
  runAsync as _runAsync,
  holdTraceOpen,
  startDetachedSpan,
  startSpan,
} from "../_internal/tracing";
import { report } from "../_internal/diagnostics";
import { applyEndUser } from "../_internal/end-user";

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

/** Subset of the Responses API request (`client.responses.create`) we read. */
export interface OpenAiResponsesCreateParams {
  model: string;
  input?: unknown;
  instructions?: string | null;
  tools?: OpenAiToolParam[];
  [key: string]: unknown;
}

/** Subset of the Responses API response we read. */
export interface OpenAiResponsesResponse {
  id?: string;
  model?: string;
  output_text?: string;
  output?: Array<{ type?: string; name?: string; arguments?: string; [k: string]: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; [k: string]: unknown };
    output_tokens_details?: { reasoning_tokens?: number; [k: string]: unknown };
    [k: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Structural shape of the plain OpenAI client we wrap. We only require
 * that `client.chat.completions.create` is a function returning a Promise;
 * `client.responses.create` is optional (absent on `openai` < 4.87).
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
  responses?: {
    create(
      params: OpenAiResponsesCreateParams,
      options?: unknown,
    ): Promise<OpenAiResponsesResponse>;
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

  const patchedCreate = buildPatchedCreate(originalCreate, options, "chat");

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

  // Responses API (`client.responses.create`) is optional: clients without
  // it (older `openai`, structural fakes) are left untouched.
  const originalResponsesCreate = client.responses?.create?.bind(client.responses);
  const patchedResponses =
    typeof originalResponsesCreate === "function"
      ? new Proxy(client.responses as object, {
          get(target, prop, receiver) {
            if (prop === "create") {
              return buildPatchedCreate(originalResponsesCreate, options, "responses");
            }
            const value = Reflect.get(target, prop, receiver);
            if (typeof value === "function") {
              return (value as (...a: unknown[]) => unknown).bind(target);
            }
            return value;
          },
        })
      : undefined;

  const wrapper = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLIENT) return true;
      if (prop === "chat") return patchedChat;
      if (prop === "responses" && patchedResponses) return patchedResponses;
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

type ApiKind = "chat" | "responses";

/* eslint-disable @typescript-eslint/no-explicit-any -- chat and responses payloads differ; shapes are read defensively */
type AnyCreate = (params: any, options?: unknown) => Promise<any>;

/** Usage numbers normalised across the two APIs. */
interface NormalisedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

function normaliseUsage(usage: any, isResponses: boolean): NormalisedUsage {
  const u = usage ?? {};
  const inputTokens = (isResponses ? u.input_tokens : u.prompt_tokens) ?? 0;
  const outputTokens = (isResponses ? u.output_tokens : u.completion_tokens) ?? 0;
  const cachedTokens =
    (isResponses
      ? u.input_tokens_details?.cached_tokens
      : u.prompt_tokens_details?.cached_tokens) ?? 0;
  const reasoningTokens =
    (isResponses
      ? u.output_tokens_details?.reasoning_tokens
      : u.completion_tokens_details?.reasoning_tokens) ?? 0;
  const totalTokens =
    u.total_tokens ?? (inputTokens > 0 || outputTokens > 0 ? inputTokens + outputTokens : 0);
  return { inputTokens, outputTokens, cachedTokens, reasoningTokens, totalTokens };
}

/**
 * Fill an llm span from a response (or a response rebuilt from a stream).
 * Best-effort, never throws.
 */
function fillSpan(
  span: SpanData,
  params: any,
  response: any,
  isResponses: boolean,
  usagePresent: boolean,
): void {
  try {
    const messages = isResponses ? responsesMessages(params) : params?.messages;
    applyEndUser(firstString(params?.user, params?.safety_identifier));
    if (isResponses) {
      const facts = responsesThreadFacts(response, params);
      if (Object.keys(facts).length > 0) span.metadata = { ...span.metadata, ...facts };
    }
    const model = response?.model ?? params?.model;
    span.model = model;
    if (usagePresent) {
      const u = normaliseUsage(response?.usage, isResponses);
      if (u.inputTokens > 0) span.input_tokens = u.inputTokens;
      if (u.outputTokens > 0) span.output_tokens = u.outputTokens;
      // MHQ-1236 parity: 0 (not absent) when usage is reported without a cache hit.
      span.cached_input_tokens = u.cachedTokens;
      if (u.reasoningTokens > 0) span.reasoning_tokens = u.reasoningTokens;
      if (u.totalTokens > 0) span.total_tokens = u.totalTokens;
      if (model && (u.inputTokens > 0 || u.outputTokens > 0)) {
        const cost = calculateCost({
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          model,
          cachedInputTokens: u.cachedTokens,
        });
        if (cost !== undefined) span.cost_usd = cost;
      }
    }
    span.context_segments = safeExtractSegments(messages, params?.tools);
    // MHQ-858: prompt/response capture, parity with the Python adapter.
    const inputData = captureInputMessages(messages);
    if (inputData !== undefined) span.input_data = inputData;
    const outputText = isResponses
      ? extractResponsesOutputText(response)
      : extractOpenAiOutputText(response?.choices);
    if (outputText !== undefined) span.output_data = { content: outputText };
  } catch (err) {
    reportSwallowed(err, "morse.openai.fill_span");
  }
}

/** A failed request: keep the requested model, no usage (never priced). */
function fillFailedSpan(span: SpanData, params: any, error: unknown): void {
  span.model = params?.model;
  if (error !== undefined) span.exception_type = errorClassName(error);
}

/**
 * Record one llm span in a trace of its own, after the call settled. Used when
 * the call was made with no trace open: the trace cannot be held open across
 * the caller's `await` without replacing the SDK's `APIPromise`, so the span
 * is written once the outcome is known, with the call's real start time.
 */
function recordInOwnTrace(
  agentName: string | undefined,
  spanName: string,
  params: any,
  startedAt: string,
  startMs: number,
  fill: (span: SpanData) => void,
  error: unknown,
): Promise<void> {
  let failure: unknown;
  return _runAsync({ agentName: agentName ?? spanName }, async (runHandle) => {
    setActiveFramework("openai");
    const late = startDetachedSpan({
      name: spanName,
      type: "llm",
      metadata: { model: params?.model },
    });
    if (late) {
      fill(late.span);
      late.end(error);
      late.span.started_at = startedAt;
      late.span.duration_ms = Date.now() - startMs;
    }
    if (error !== undefined) {
      failure = error;
      throw error;
    }
    runHandle.setOutcome(true);
    return null;
  }).then(
    () => undefined,
    (err: unknown) => {
      if (err !== failure) throw err;
    },
  );
}

/* ------------------------------------------------------------------------ */
/*  Streaming (MHQ-1407): create({ stream: true })                           */
/* ------------------------------------------------------------------------ */

interface ChatStreamAcc {
  kind: "chat";
  chunks: number;
  model?: string;
  usage?: any;
  text: string[];
  toolCalls: Map<number, { name?: string; args: string[] }>;
  finishReason?: string;
}

interface ResponsesStreamAcc {
  kind: "responses";
  chunks: number;
  latest?: any;
  terminal?: string;
}

type StreamAcc = ChatStreamAcc | ResponsesStreamAcc;

const RESPONSES_TERMINAL = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

function newAcc(isResponses: boolean): StreamAcc {
  return isResponses
    ? { kind: "responses", chunks: 0 }
    : { kind: "chat", chunks: 0, text: [], toolCalls: new Map() };
}

/** Fold one chunk/event into the accumulator. Never throws. */
function accumulate(acc: StreamAcc, event: any): void {
  try {
    acc.chunks += 1;
    if (acc.kind === "responses") {
      if (event?.response && typeof event.response === "object") acc.latest = event.response;
      if (typeof event?.type === "string" && RESPONSES_TERMINAL.has(event.type)) {
        acc.terminal = event.type;
      }
      return;
    }
    if (typeof event?.model === "string") acc.model = event.model;
    if (event?.usage) acc.usage = event.usage;
    for (const choice of event?.choices ?? []) {
      if ((choice?.index ?? 0) !== 0) continue;
      if (typeof choice.finish_reason === "string") acc.finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (typeof delta?.content === "string" && delta.content) acc.text.push(delta.content);
      for (const tc of delta?.tool_calls ?? []) {
        const idx = typeof tc?.index === "number" ? tc.index : 0;
        const slot = acc.toolCalls.get(idx) ?? { args: [] };
        if (typeof tc?.function?.name === "string") slot.name = tc.function.name;
        if (typeof tc?.function?.arguments === "string") slot.args.push(tc.function.arguments);
        acc.toolCalls.set(idx, slot);
      }
    }
  } catch {
    // telemetry must never break the caller's stream
  }
}

/** The response the stream amounts to, plus stream metadata. */
function settleAcc(acc: StreamAcc): {
  response: any;
  usagePresent: boolean;
  meta: Record<string, unknown>;
} {
  const meta: Record<string, unknown> = { streamed: true };
  if (acc.kind === "responses") {
    if (acc.chunks > 0 && acc.terminal === undefined) meta.stream_incomplete = true;
    if (acc.terminal && acc.terminal !== "response.completed") {
      meta.response_status = acc.terminal.slice("response.".length);
    }
    return { response: acc.latest, usagePresent: Boolean(acc.latest?.usage), meta };
  }
  if (acc.usage === undefined) meta.usage_unavailable = true; // no stream_options.include_usage
  if (acc.chunks > 0 && acc.finishReason === undefined) meta.stream_incomplete = true;
  const toolCalls = [...acc.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => ({
      function: { name: slot.name ?? "tool", arguments: slot.args.join("") || undefined },
    }));
  const response = {
    model: acc.model,
    usage: acc.usage,
    choices: [
      {
        message: {
          content: acc.text.join("") || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      },
    ],
  };
  return { response, usagePresent: acc.usage !== undefined, meta };
}

function buildPatchedCreate(
  original: AnyCreate,
  options: WrapOpenAiOptions,
  api: ApiKind,
): AnyCreate {
  const agentName = options.defaultAgentName;
  const isResponses = api === "responses";
  const spanName = isResponses ? "openai.responses.create" : "openai.chat.completions.create";
  const ownTraceName = isResponses ? (agentName ?? spanName) : agentName;

  // Not `async`: the SDK's `create()` returns an `APIPromise`, and callers use
  // `.withResponse()` / `.asResponse()` on it. Returning a plain Promise broke
  // them (the MHQ-1415 Anthropic bug, same shape here).
  return function patchedCreate(this: unknown, params: any, callOptions?: unknown): Promise<any> {
    const inTrace = getActiveTraceState() !== null;
    const streaming = params?.stream === true;
    const startedAt = nowIso();
    const startMs = Date.now();
    setActiveFramework("openai");
    // A stream's span is detached (not on the stack) so work done while the
    // caller reads the stream does not nest under it; parented at call time.
    const handle = inTrace
      ? streaming
        ? startDetachedSpan({ name: spanName, type: "llm", metadata: { model: params?.model } })
        : startSpan({ name: spanName, type: "llm", metadata: { model: params?.model } })
      : null;
    const acc = streaming ? newAcc(isResponses) : null;
    // A stream read after `run()`'s callback returned (a streamed route) keeps
    // the trace open until it ends (MHQ-1407).
    const releaseTrace = handle && streaming ? holdTraceOpen() : null;
    let done = false;

    const fill = (span: SpanData, response: any, error: unknown): void => {
      if (error !== undefined && !acc) {
        fillFailedSpan(span, params, error);
        return;
      }
      if (acc) {
        const settled = settleAcc(acc);
        fillSpan(span, params, settled.response, isResponses, settled.usagePresent);
        if (settled.response === undefined) span.model = params?.model;
        span.metadata = { ...(span.metadata ?? {}), ...settled.meta };
        if (error !== undefined) span.exception_type = errorClassName(error);
        return;
      }
      fillSpan(span, params, response, isResponses, response?.usage !== undefined);
    };

    const settle = (response: any, error: unknown): void => {
      if (done) return;
      done = true;
      if (handle) {
        fill(handle.span, response, error);
        handle.end(error);
        releaseTrace?.();
        return;
      }
      if (inTrace) return; // trace closed between call and settle: nothing to attach to
      void recordInOwnTrace(
        ownTraceName,
        spanName,
        params,
        startedAt,
        startMs,
        (span) => fill(span, response, error),
        error,
      ).catch(() => undefined);
    };

    let p: Promise<any>;
    try {
      p = original.call(this, params, callOptions);
    } catch (err) {
      settle(undefined, err);
      throw err;
    }
    const out = mapKeepingShape(p, (response: any) => {
      if (!acc) {
        settle(response, undefined);
        return response;
      }
      if (!response || typeof response !== "object") {
        settle(undefined, undefined);
        return response;
      }
      return wrapEventStream(
        response as object,
        (event) => accumulate(acc, event),
        (error) => settle(undefined, error),
      );
    }) as Promise<any>;
    // Observe the promise we hand back, not `p`: openai's `_thenUnwrap` builds
    // a second APIPromise over the same response, and each one parses the body
    // on its first `.then`, so a `.then` on `p` too read the body twice
    // ("Body is unusable"). The returned one memoises its parse.
    onRejected(out, (err) => settle(undefined, err));
    return out;
  };
}

function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name || "Error" : typeof error;
}
function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === "string" && v !== "") return v;
  return undefined;
}

/** SETUP-09: `response_id` / `previous_response_id` / `conversation_id`, only keys present. */
function responsesThreadFacts(response: any, params: any): Record<string, string> {
  const facts: Record<string, string> = {};
  const rid = firstString(response?.id);
  if (rid !== undefined) facts.response_id = rid;
  const prev = firstString(params?.previous_response_id);
  if (prev !== undefined) facts.previous_response_id = prev;
  const conv = params?.conversation;
  const convId = typeof conv === "string" ? firstString(conv) : firstString(conv?.id);
  if (convId !== undefined) facts.conversation_id = convId;
  return facts;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Normalise Responses API `instructions` + `input` into chat-style messages
 * so input capture and the shared context decomposer see one shape for both
 * APIs. Mirrors Python's `_responses_messages`: a string `input` is one user
 * turn; list items carrying a `role` are kept, other item types
 * (function_call_output, reasoning, ...) are skipped.
 */
function responsesMessages(
  params: OpenAiResponsesCreateParams | undefined,
): OpenAiChatMessageParam[] {
  if (!params || typeof params !== "object") return [];
  const out: OpenAiChatMessageParam[] = [];
  if (typeof params.instructions === "string" && params.instructions) {
    out.push({ role: "system", content: params.instructions });
  }
  const input = params.input;
  if (typeof input === "string" && input) {
    out.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const m = item as { role?: unknown; content?: unknown } | null;
      if (m && typeof m === "object" && typeof m.role === "string") {
        out.push({ role: m.role, content: m.content });
      }
    }
  }
  return out;
}

/**
 * Text output of a Responses API response: `output_text` plus any
 * `function_call` items as `[tool_call:name] args`, so a tool-only turn is
 * not blank. Mirrors Python's `_extract_responses_output_text`.
 */
function extractResponsesOutputText(
  response: OpenAiResponsesResponse | undefined,
): string | undefined {
  const parts: string[] = [];
  if (typeof response?.output_text === "string" && response.output_text) {
    parts.push(response.output_text);
  }
  for (const item of response?.output ?? []) {
    if (item?.type !== "function_call") continue;
    const label = `[tool_call:${item.name || "tool"}]`;
    parts.push(item.arguments ? `${label} ${item.arguments}` : label);
  }
  if (parts.length === 0) return undefined;
  return truncateText(parts.join("\n"));
}

function safeExtractSegments(messages: unknown, tools: unknown): ContextSegment[] {
  try {
    return decomposeOpenAiMessages(
      messages as OpenAiChatMessageParam[] | undefined,
      tools as OpenAiToolParam[] | undefined,
    );
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
