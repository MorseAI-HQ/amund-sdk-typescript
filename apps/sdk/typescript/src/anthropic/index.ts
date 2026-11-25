/**
 * `@amundai/sdk/anthropic` — Anthropic SDK instrumentation.
 *
 * Wraps `@anthropic-ai/sdk` `client.messages.create` so every Claude call
 * emits an `llm` span carrying pre-segmented `context_segments`. The
 * server-side classifier then skips its own messages-array partitioning
 * and persists the SDK-supplied segments verbatim.
 *
 * Two entry points:
 *
 *   - `wrapAnthropic(client)` — returns a Proxy-like wrapper that
 *     intercepts `messages.create`. Always succeeds. The customer keeps
 *     using the wrapper as if it were the real client.
 *
 *   - `instrumentAnthropic(client?)` — top-level helper. If a client is
 *     passed, returns the wrapped form. If no client is passed AND the
 *     `@anthropic-ai/sdk` package can be loaded, attempts to patch
 *     `Messages.prototype.create` so every fresh `new Anthropic()` is
 *     instrumented automatically. The prototype path is best-effort —
 *     it is documented as fragile across Anthropic SDK versions, and
 *     `wrapAnthropic` is the recommended public entry.
 *
 * Idempotent. `uninstallAnthropic()` restores the prototype and clears
 * the install sentinel.
 *
 * Wrapped under `absorbErrors*` so a tracing failure can never break the
 * customer's Anthropic call — at worst, calls go untraced.
 *
 * Mirrors `apps/sdk/typescript/src/vercel-ai/index.ts` in shape and
 * `openspec/changes/.../specs/observability/spec.md` (CTX-08) in
 * segmentation contract.
 */

import { absorbErrorsAsync, absorbErrorsSync } from "../_internal/errors";
import { calculateCost } from "../_internal/pricing";
import type { ContextSegment, SpanData } from "../_internal/spans";
import { generateSpanId, nowIso } from "../_internal/spans";
import { prepareLlmCall } from "../propagation";
import { setActiveFramework } from "../_internal/active-framework";
import { captureInputMessages, extractAnthropicOutputText } from "../_internal/llm-io";
import { applyEndUser } from "../_internal/end-user";
import {
  getActiveTraceState,
  holdTraceOpen,
  runAsync as _runAsync,
  startDetachedSpan,
  startSpan,
} from "../_internal/tracing";

/* ------------------------------------------------------------------------ */
/*  Public types — minimal structural shapes, NOT a hard dep on `@anthropic-ai/sdk` */
/* ------------------------------------------------------------------------ */

/**
 * Subset of `@anthropic-ai/sdk`'s `MessageCreateParams` we read from. We
 * deliberately decline to import the real types so the SDK works even when
 * `@anthropic-ai/sdk` isn't installed (it's an optional peer dep).
 */
export interface AnthropicMessageCreateParams {
  model: string;
  max_tokens?: number;
  system?: string | AnthropicTextBlockParam[];
  messages: AnthropicMessageParam[];
  tools?: AnthropicToolParam[];
  tool_choice?: unknown;
  // Allow forward-compat fields without complaint.
  [key: string]: unknown;
}

export interface AnthropicTextBlockParam {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" } | null;
}

export interface AnthropicToolUseBlockParam {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  is_error?: boolean;
}

export type AnthropicContentBlockParam =
  | AnthropicTextBlockParam
  | AnthropicToolUseBlockParam
  | AnthropicToolResultBlockParam
  | { type: string; [k: string]: unknown };

export interface AnthropicMessageParam {
  role: "user" | "assistant" | string;
  content: string | AnthropicContentBlockParam[];
}

export interface AnthropicToolParam {
  name: string;
  description?: string;
  input_schema?: unknown;
  // Anthropic supports custom tool types — let through.
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

export interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  usage?: AnthropicUsage;
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Structural shape of the Anthropic client we wrap. We only require that
 * `client.messages.create` is a function returning a Promise.
 */
export interface AnthropicClientLike {
  messages: {
    create(
      params: AnthropicMessageCreateParams,
      options?: unknown,
    ): Promise<AnthropicMessageResponse>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------ */
/*  Module-level install sentinels                                           */
/* ------------------------------------------------------------------------ */

const WRAPPED_CLIENT = Symbol.for("morse.anthropic.wrapped");
const INSTALL_SENTINEL = Symbol.for("morse.anthropic.installed");
const ORIGINALS_SENTINEL = Symbol.for("morse.anthropic.originals");

/**
 * True once `instrumentAnthropic()` has successfully patched
 * `Messages.prototype.create` globally (called directly, or via
 * `_internal/auto-detect.ts`'s zero-config scan). Mirrors the Python SDK's
 * `wrap()` check on `anthropic._morse_ai_installed` (AGE-240 dogfood fix):
 * without this guard, a customer who lets auto-detect patch the prototype
 * AND then calls `wrapAnthropic(client)` manually on an instance would
 * record every `messages.create` call twice — once via the global patch,
 * once via the per-instance Proxy. `wrapAnthropic()` checks this flag and
 * returns the client unmodified when a global install is already active,
 * leaving the global patch as the sole recorder.
 */
let globalInstallActive = false;

interface OriginalsBag {
  protoCreate?: unknown;
  protoCarrier?: { prototype: { create: unknown } };
}

interface InstalledModule {
  [INSTALL_SENTINEL]?: boolean;
  [ORIGINALS_SENTINEL]?: OriginalsBag;
}

/**
 * Install state keyed by the patched `Messages.prototype`, not by properties on
 * the module object. The CommonJS export of `@anthropic-ai/sdk` is the client
 * *class* (a function) and an ESM namespace is not extensible, so writing a
 * sentinel onto the module threw after the prototype was already patched: the
 * install reported failure, `wrapAnthropic` then recorded every call a second
 * time, and the CommonJS build was never patched at all (MHQ-1415 follow-up).
 */
const patchedPrototypes = new WeakMap<object, OriginalsBag>();

function markModule(mod: unknown, installed: boolean, bag?: OriginalsBag): void {
  try {
    (mod as InstalledModule)[INSTALL_SENTINEL] = installed;
    (mod as InstalledModule)[ORIGINALS_SENTINEL] = bag;
  } catch {
    // non-extensible namespace: the WeakMap is the source of truth
  }
}

/* ------------------------------------------------------------------------ */
/*  Public API                                                               */
/* ------------------------------------------------------------------------ */

export interface InstrumentAnthropicOptions {
  /**
   * When provided, used as the parent agent span's name. Defaults to
   * `"anthropic.messages.create"`.
   */
  defaultAgentName?: string;
  /**
   * If a fresh Anthropic *module* import is passed (e.g.,
   * `await import("@anthropic-ai/sdk")`), the adapter will best-effort
   * patch `Messages.prototype.create`. Most users should prefer
   * `wrapAnthropic(client)` instead.
   */
  anthropicModule?: unknown;
  /**
   * When `true` (MEM-11), every wrapped `messages.create` call also
   * emits a sibling `memory`-type span with
   * `metadata.memory_op_type="consolidate"`, `parent_span_id` linking
   * back to the LLM span (server treats this as `producer_span_id`),
   * `metadata.summary_token_count` from the response's output_tokens,
   * and `metadata.summary_content_hash` (SHA-256 of the response's
   * first text block).
   *
   * Use this flag when the customer is calling Claude to summarize
   * their own conversation context (the customer-side compaction
   * pattern). Default `false` — existing callers see zero behavior change.
   *
   * Opt-in only. The adapter never auto-detects summarization from
   * system-prompt content (too many false positives).
   */
  summarize?: boolean;
  /**
   * Default `true` (MHQ-1880). Calls made inside an active trace send a W3C
   * `traceparent` request header naming the call's `llm` span, so a gateway that
   * forwards it joins the trace. A `traceparent` you set is never replaced.
   * `false` sends nothing; `AMUND_PROPAGATE_TRACE_CONTEXT=false` does the same globally.
   */
  propagateTraceContext?: boolean;
}

/**
 * Whether this client's `messages` inherits a prototype the global install
 * patched. `undefined` for a plain-object (duck-typed) client, where only the
 * global flag can answer. The CommonJS and ESM builds of `@anthropic-ai/sdk`
 * are separate classes, so a global install of one must not stop `wrapAnthropic`
 * from instrumenting a client built from the other.
 */
function clientUsesPatchedPrototype(client: AnthropicClientLike): boolean | undefined {
  const msgs = (client as { messages?: unknown }).messages;
  if (!msgs || typeof msgs !== "object") return undefined;
  let proto: object | null = Object.getPrototypeOf(msgs) as object | null;
  if (proto === null || proto === Object.prototype) return undefined;
  while (proto !== null && proto !== Object.prototype) {
    if (patchedPrototypes.has(proto)) return true;
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return false;
}

/**
 * Wrap an Anthropic client so every `messages.create` call records an
 * `llm` span with `context_segments`. The wrapper preserves the rest of
 * the client's surface (other resources, helpers, etc.) via a Proxy.
 *
 * Idempotent — a previously wrapped client is returned as-is.
 */
export function wrapAnthropic<C extends AnthropicClientLike>(
  client: C,
  options: InstrumentAnthropicOptions = {},
): C {
  if (!client || typeof client !== "object") return client;
  // Already wrapped? Pass through.
  if ((client as Record<string | symbol, unknown>)[WRAPPED_CLIENT]) return client;
  // A global install (manual `instrumentAnthropic()` or auto-detect) is
  // already recording every call at the prototype level — see
  // `globalInstallActive` doc comment above.
  const patched = clientUsesPatchedPrototype(client);
  if (patched === true || (patched === undefined && globalInstallActive)) return client;

  const originalCreate = client.messages?.create?.bind(client.messages);
  if (typeof originalCreate !== "function") return client;

  const patchedCreate = buildPatchedCreate(originalCreate, options);

  // We construct a new `messages` object that proxies to the original
  // for any non-`create` access, then a top-level proxy that returns
  // our patched `messages` while passing every other property through.
  const patchedMessages = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop === "create") return patchedCreate;
      const value = Reflect.get(target, prop, receiver);
      // MHQ-1415: `messages.stream()` calls `this.create({ stream: true })`;
      // bound to the proxy it goes through the patched create and is traced.
      if (prop === "stream" && typeof value === "function") {
        return (value as (...a: unknown[]) => unknown).bind(receiver);
      }
      // Bind methods so `this` continues to point at the original.
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });

  const wrapper = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_CLIENT) return true;
      if (prop === "messages") return patchedMessages;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });

  return wrapper as C;
}

/**
 * Top-level installer. Two modes:
 *
 *   - `instrumentAnthropic(client)` — equivalent to `wrapAnthropic(client)`.
 *   - `instrumentAnthropic({ anthropicModule: mod })` — best-effort
 *     prototype patch. Prefer the wrap form when possible.
 *
 * Always returns the wrapped client, or `undefined` if patching failed.
 * Errors are absorbed; this function never throws back at the caller.
 */
export const instrumentAnthropic = absorbErrorsAsync(
  async <C extends AnthropicClientLike>(
    clientOrOptions?: C | InstrumentAnthropicOptions,
    maybeOptions?: InstrumentAnthropicOptions,
  ): Promise<C | boolean> => {
    // Disambiguate the overloads.
    if (clientOrOptions && isClient(clientOrOptions)) {
      const opts = maybeOptions ?? {};
      return wrapAnthropic(clientOrOptions as C, opts);
    }
    const opts = (clientOrOptions as InstrumentAnthropicOptions | undefined) ?? {};
    const mod = await loadAnthropicModule(opts.anthropicModule);
    if (!mod) return false;
    const carrier = findMessagesPrototypeCarrier(mod);
    if (!carrier) return false;
    if (patchedPrototypes.has(carrier.prototype)) {
      globalInstallActive = true;
      return true;
    }
    const originalCreate = carrier.prototype.create;
    if (typeof originalCreate !== "function") return false;

    const patchedCreate = buildPatchedCreate(function (
      this: unknown,
      params: AnthropicMessageCreateParams,
      callOptions?: unknown,
    ) {
      return (originalCreate as (...args: unknown[]) => Promise<AnthropicMessageResponse>).call(
        this,
        params,
        callOptions,
      );
    }, opts);
    carrier.prototype.create = patchedCreate as unknown as typeof carrier.prototype.create;
    const bag: OriginalsBag = { protoCreate: originalCreate, protoCarrier: carrier };
    patchedPrototypes.set(carrier.prototype, bag);
    markModule(mod, true, bag);
    globalInstallActive = true;
    return true;
  },
  { fingerprint: "morse.adapters.anthropic.install" },
);

/**
 * Restore the prototype patch and clear the install sentinel.
 *
 * Pass the same module reference that was given to `instrumentAnthropic`
 * (or omit and the function will try to dynamic-import it). Calling
 * `uninstallAnthropic()` on a wrapped client (vs. a module) is a no-op —
 * just discard the wrapped client.
 */
export const uninstallAnthropic = absorbErrorsSync(
  (anthropicModule?: unknown): void => {
    if (
      !anthropicModule ||
      (typeof anthropicModule !== "object" && typeof anthropicModule !== "function")
    ) {
      return;
    }
    const carrier = findMessagesPrototypeCarrier(anthropicModule);
    const originals = carrier ? patchedPrototypes.get(carrier.prototype) : undefined;
    if (!originals) return;
    if (originals.protoCarrier && originals.protoCreate !== undefined) {
      originals.protoCarrier.prototype.create =
        originals.protoCreate as typeof originals.protoCarrier.prototype.create;
    }
    patchedPrototypes.delete(carrier!.prototype);
    markModule(anthropicModule, false, undefined);
    globalInstallActive = false;
  },
  { fingerprint: "morse.adapters.anthropic.uninstall" },
);

/**
 * Reset module-level install state for tests. Not part of the public API.
 * @internal
 */
export function _resetAnthropicInstallStateForTesting(): void {
  globalInstallActive = false;
}

/** True when a wrapped Anthropic client is passed in. */
export function isAnthropicWrapped(client: unknown): boolean {
  if (!client || typeof client !== "object") return false;
  return (client as Record<string | symbol, unknown>)[WRAPPED_CLIENT] === true;
}

/* ------------------------------------------------------------------------ */
/*  Internals — module discovery                                             */
/* ------------------------------------------------------------------------ */

function isClient(x: unknown): x is AnthropicClientLike {
  if (!x || typeof x !== "object") return false;
  const messages = (x as { messages?: { create?: unknown } }).messages;
  return !!messages && typeof messages.create === "function";
}

async function loadAnthropicModule(explicit?: unknown): Promise<unknown | null> {
  // The CommonJS export is the client class itself, so accept a function too.
  if (explicit && (typeof explicit === "object" || typeof explicit === "function")) return explicit;
  try {
    // Function-eval'd dynamic import keeps bundlers from trying to resolve
    // `@anthropic-ai/sdk` at build time when the dep isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (Function("m", "return import(m)") as any)("@anthropic-ai/sdk");
  } catch {
    return null;
  }
}

/**
 * Locate the Messages class prototype on the Anthropic SDK module.
 * The SDK has historically exposed it at slightly different paths across
 * versions; we try the most common shapes.
 */
function findMessagesPrototypeCarrier(mod: unknown): { prototype: { create: unknown } } | null {
  if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return null;
  const m = mod as Record<string, unknown>;

  // Strategy 1: `mod.Anthropic.Messages` (default-export class with static).
  const Default = m.default ?? m.Anthropic ?? m;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: any[] = [
    (Default as Record<string, unknown> | undefined)?.Messages,
    (m as Record<string, unknown>).Messages,
    (Default as { resources?: { Messages?: unknown } } | undefined)?.resources?.Messages,
  ];
  for (const c of candidates) {
    if (c && typeof c === "function" && c.prototype && typeof c.prototype.create === "function") {
      return c as { prototype: { create: unknown } };
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/*  Internals — wrapper that records an `llm` span                           */
/* ------------------------------------------------------------------------ */

/**
 * The Anthropic SDK's `create()` returns an `APIPromise`: a Promise with extra
 * methods (`withResponse()`, `asResponse()`) that the SDK itself relies on —
 * `messages.stream()` calls `create(...).withResponse()`. A wrapper that
 * returns a plain Promise breaks those callers (MHQ-1415: `messages.stream()`
 * threw `withResponse is not a function` under the auto-detect install).
 * `_thenUnwrap` maps the resolved value while keeping the APIPromise shape;
 * fakes and very old SDKs without it fall back to `.then`.
 */
interface ApiPromiseLike<T> extends PromiseLike<T> {
  _thenUnwrap?: <U>(transform: (data: T) => U) => PromiseLike<U>;
}

function mapKeepingShape<T, U>(p: PromiseLike<T>, transform: (data: T) => U): PromiseLike<U> {
  const api = p as ApiPromiseLike<T>;
  if (typeof api._thenUnwrap === "function") return api._thenUnwrap(transform);
  return p.then(transform);
}

/** Observe a rejection without handling it for the caller. */
function onRejected(p: PromiseLike<unknown>, handler: (err: unknown) => void): void {
  try {
    // `p.then` directly (not `Promise.resolve(p)`), so this handler runs before
    // the caller's own `await` resumes and can still close the span in-trace.
    p.then(undefined, (err: unknown) => {
      try {
        handler(err);
      } catch {
        // swallow — telemetry must never break the caller
      }
    });
  } catch {
    // swallow
  }
}

const SPAN_NAME = "anthropic.messages.create";

function spanOptions(params: AnthropicMessageCreateParams) {
  return {
    name: SPAN_NAME,
    type: "llm" as const,
    metadata: { model: params?.model, max_tokens: params?.max_tokens },
  };
}

/** MHQ-1880: the provider's message id (`msg_...`); the server merges a gateway's record by it. */
function setResponseId(span: SpanData, id: unknown): void {
  if (typeof id !== "string" || id === "" || span.metadata?.response_id !== undefined) return;
  span.metadata = { ...(span.metadata ?? {}), response_id: id };
}

/** Fill an llm span from a non-streaming Message. Best-effort, never throws. */
function fillResponseSpan(
  span: SpanData,
  params: AnthropicMessageCreateParams,
  response: AnthropicMessageResponse | undefined,
): void {
  try {
    const segments = safeExtractSegments(params, response);
    applyEndUser((params?.metadata as { user_id?: unknown } | undefined)?.user_id);
    const usage = response?.usage ?? {};
    const inputTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    const outputTokens = usage.output_tokens ?? 0;
    span.model = response?.model ?? params?.model;
    setResponseId(span, response?.id);
    if (inputTokens > 0) span.input_tokens = inputTokens;
    if (outputTokens > 0) span.output_tokens = outputTokens;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    if (cacheWrite > 0) span.cache_write_tokens = cacheWrite;
    if (cacheRead > 0) span.cached_input_tokens = cacheRead;
    if (inputTokens > 0 || outputTokens > 0) {
      span.total_tokens = inputTokens + outputTokens;
    }
    if (span.cost_usd === undefined && span.model && (inputTokens > 0 || outputTokens > 0)) {
      const cost = calculateCost({
        inputTokens,
        outputTokens,
        model: span.model,
        cachedInputTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      });
      if (cost !== undefined) span.cost_usd = cost;
    }
    span.context_segments = segments;
    // MHQ-858: prompt/response capture, parity with Python's
    // `_safe_input_messages` / `_extract_output_text`.
    const inputData = captureInputMessages(params?.messages, params?.system);
    if (inputData !== undefined) span.input_data = inputData;
    const outputText = extractAnthropicOutputText(response?.content);
    if (outputText !== undefined) span.output_data = { content: outputText };
  } catch {
    // swallow — telemetry must never break the caller
  }
}

/**
 * Record one llm span in a trace of its own, after the call settled. Used when
 * the call was made with no trace open: the trace cannot be held open across
 * the caller's `await` without replacing the SDK's `APIPromise`, so the span
 * is written once the outcome is known, with the call's real start time.
 */
function recordInOwnTrace(
  agentName: string | undefined,
  params: AnthropicMessageCreateParams,
  startedAt: string,
  startMs: number,
  fill: (span: SpanData) => void,
  error: unknown,
  after?: (span: SpanData) => void,
): Promise<void> {
  let failure: unknown;
  return _runAsync({ agentName }, async (runHandle) => {
    setActiveFramework("anthropic");
    const late = startDetachedSpan(spanOptions(params));
    if (late) {
      fill(late.span);
      late.end(error);
      late.span.started_at = startedAt;
      late.span.duration_ms = Date.now() - startMs;
      after?.(late.span);
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

function buildPatchedCreate(
  original: (
    params: AnthropicMessageCreateParams,
    options?: unknown,
  ) => Promise<AnthropicMessageResponse>,
  options: InstrumentAnthropicOptions,
): (params: AnthropicMessageCreateParams, options?: unknown) => Promise<AnthropicMessageResponse> {
  const agentName = options.defaultAgentName;
  const summarizeMode = options.summarize === true;
  const propagate = options.propagateTraceContext !== false;

  return function patchedCreate(
    this: unknown,
    params: AnthropicMessageCreateParams,
    callOptions?: unknown,
  ): Promise<AnthropicMessageResponse> {
    const inTrace = getActiveTraceState() !== null;

    // MHQ-1415: `create({ stream: true })` resolves to an event stream, not a
    // Message. Usage arrives in `message_start` / `message_delta`, so the span
    // is recorded when the stream ends, from the accumulated events.
    if (params?.stream === true) {
      return tracedStreamCreate(this, original, params, callOptions, agentName, inTrace, propagate);
    }

    const startedAt = nowIso();
    const startMs = Date.now();
    setActiveFramework("anthropic");
    const handle = inTrace ? startSpan(spanOptions(params)) : null;
    let done = false;

    const emitMemory = (span: SpanData, response?: AnthropicMessageResponse): void => {
      // MEM-11: emit sibling memory span when summarize mode is enabled.
      // Sequenced AFTER the LLM span closes so its span_id is final.
      if (!summarizeMode) return;
      try {
        emitSummarizeMemorySpan(span, response);
      } catch {
        // swallow — telemetry must never break the caller
      }
    };

    const settle = (response: AnthropicMessageResponse | undefined, error: unknown): void => {
      if (done) return;
      done = true;
      if (handle) {
        if (error === undefined) fillResponseSpan(handle.span, params, response);
        else handle.span.model = params?.model;
        handle.end(error);
        if (error === undefined) emitMemory(handle.span, response);
        return;
      }
      if (inTrace) return; // trace closed between call and settle: nothing to attach to
      void recordInOwnTrace(
        agentName,
        params,
        startedAt,
        startMs,
        (span) => {
          if (error === undefined) fillResponseSpan(span, params, response);
          else span.model = params?.model;
        },
        error,
        (span) => {
          if (error === undefined) emitMemory(span, response);
        },
      ).catch(() => undefined);
    };

    let p: Promise<AnthropicMessageResponse>;
    try {
      // MHQ-1880: the header names this call's llm span (`handle` exists only in a trace).
      p = original.call(this, params, prepareLlmCall(callOptions, handle?.span.span_id, propagate));
    } catch (err) {
      settle(undefined, err);
      throw err;
    }
    // Observe the promise handed back, not `p`: a second `.then` on the SDK's
    // APIPromise parses the body again ("Body is unusable"). OpenAI's wrapper does the same.
    const out = mapKeepingShape(p, (response) => {
      settle(response, undefined);
      return response;
    }) as Promise<AnthropicMessageResponse>;
    onRejected(out, (err) => settle(undefined, err));
    return out;
  };
}

/* ------------------------------------------------------------------------ */
/*  Streaming (MHQ-1415): create({ stream: true })                           */
/* ------------------------------------------------------------------------ */

interface StreamAccumulator {
  model?: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheWrite: number;
  cacheRead: number;
  text: string[];
  stopReason?: string;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

interface RawStreamEvent {
  type?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
  usage?: Record<string, unknown>;
  delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
}

/** Fold one raw stream event into the accumulator. Never throws. */
function accumulateStreamEvent(acc: StreamAccumulator, event: unknown): void {
  try {
    if (!event || typeof event !== "object") return;
    const e = event as RawStreamEvent;
    if (e.type === "message_start" && e.message) {
      if (typeof e.message.model === "string") acc.model = e.message.model;
      if (typeof e.message.id === "string" && e.message.id !== "") acc.responseId = e.message.id;
      const u = e.message.usage ?? {};
      acc.inputTokens = numOr(u.input_tokens, acc.inputTokens);
      acc.outputTokens = numOr(u.output_tokens, acc.outputTokens);
      acc.cacheWrite = numOr(u.cache_creation_input_tokens, acc.cacheWrite);
      acc.cacheRead = numOr(u.cache_read_input_tokens, acc.cacheRead);
    } else if (e.type === "message_delta") {
      // message_delta usage is cumulative; newer API versions also repeat
      // the input/cache counts here.
      const u = e.usage ?? {};
      acc.outputTokens = numOr(u.output_tokens, acc.outputTokens);
      acc.inputTokens = numOr(u.input_tokens, acc.inputTokens);
      acc.cacheWrite = numOr(u.cache_creation_input_tokens, acc.cacheWrite);
      acc.cacheRead = numOr(u.cache_read_input_tokens, acc.cacheRead);
      if (typeof e.delta?.stop_reason === "string") acc.stopReason = e.delta.stop_reason;
    } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      if (typeof e.delta.text === "string") acc.text.push(e.delta.text);
    }
  } catch {
    // telemetry must never break the caller's stream
  }
}

function fillStreamSpan(
  span: SpanData,
  acc: StreamAccumulator,
  params: AnthropicMessageCreateParams,
  error: unknown,
): void {
  span.model = acc.model ?? params?.model;
  setResponseId(span, acc.responseId);
  const inputTokens = acc.inputTokens + acc.cacheWrite + acc.cacheRead;
  if (inputTokens > 0) span.input_tokens = inputTokens;
  if (acc.outputTokens > 0) span.output_tokens = acc.outputTokens;
  if (acc.cacheWrite > 0) span.cache_write_tokens = acc.cacheWrite;
  if (acc.cacheRead > 0) span.cached_input_tokens = acc.cacheRead;
  if (inputTokens > 0 || acc.outputTokens > 0) {
    span.total_tokens = inputTokens + acc.outputTokens;
    if (span.model) {
      const cost = calculateCost({
        inputTokens,
        outputTokens: acc.outputTokens,
        model: span.model,
        cachedInputTokens: acc.cacheRead,
        cacheWriteTokens: acc.cacheWrite,
      });
      if (cost !== undefined) span.cost_usd = cost;
    }
  }
  const metadata: Record<string, unknown> = { ...(span.metadata ?? {}), streamed: true };
  if (error === undefined && acc.stopReason === undefined) {
    // The caller stopped reading before the final event: output is partial.
    metadata.stream_incomplete = true;
  }
  span.metadata = metadata;
  const inputData = captureInputMessages(params?.messages, params?.system);
  if (inputData !== undefined) span.input_data = inputData;
  if (acc.text.length > 0) span.output_data = { content: acc.text.join("") };
}

/** Proxy a stream so iterating it feeds `onEvent` and `onFinish` runs once. */
function wrapEventStream<S extends object>(
  stream: S,
  onEvent: (event: unknown) => void,
  onFinish: (error: unknown) => void,
): S {
  const iterFn = (stream as Record<symbol, unknown>)[Symbol.asyncIterator];
  if (typeof iterFn !== "function") {
    onFinish(undefined);
    return stream;
  }
  let finished = false;
  const finish = (error: unknown): void => {
    if (finished) return;
    finished = true;
    try {
      onFinish(error);
    } catch {
      // swallow — telemetry must never break the caller
    }
  };
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function tracedIterator(): AsyncIterator<unknown> {
          const it = (iterFn as () => AsyncIterator<unknown>).call(target);
          const wrapped: AsyncIterator<unknown> & AsyncIterable<unknown> = {
            async next(...args: [] | [unknown]) {
              let result: IteratorResult<unknown>;
              try {
                result = await it.next(...args);
              } catch (err) {
                finish(err);
                throw err;
              }
              if (result.done) finish(undefined);
              else onEvent(result.value);
              return result;
            },
            async return(value?: unknown) {
              finish(undefined);
              if (typeof it.return === "function") return it.return(value);
              return { done: true, value };
            },
            async throw(err?: unknown) {
              finish(err);
              if (typeof it.throw === "function") return it.throw(err);
              throw err;
            },
            [Symbol.asyncIterator]() {
              return wrapped;
            },
          };
          return wrapped;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });
}

function tracedStreamCreate(
  self: unknown,
  original: (
    params: AnthropicMessageCreateParams,
    options?: unknown,
  ) => Promise<AnthropicMessageResponse>,
  params: AnthropicMessageCreateParams,
  callOptions: unknown,
  agentName: string | undefined,
  inTrace: boolean,
  propagate: boolean,
): Promise<AnthropicMessageResponse> {
  const startedAt = nowIso();
  const startMs = Date.now();
  const acc: StreamAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWrite: 0,
    cacheRead: 0,
    text: [],
  };
  setActiveFramework("anthropic");
  // In a trace: a detached span (not on the stack, so work done while the
  // caller reads the stream does not nest under it), parented at call time.
  const detached = inTrace ? startDetachedSpan(spanOptions(params)) : null;
  let recorded = false;
  // A stream read after `run()`'s callback returned (a streamed route) keeps
  // the trace open until it ends (MHQ-1407).
  const releaseTrace = detached ? holdTraceOpen() : null;

  const record = (error: unknown): void => {
    if (recorded) return;
    recorded = true;
    if (detached) {
      fillStreamSpan(detached.span, acc, params, error);
      detached.end(error);
      if (error !== undefined) detached.span.exception_type = errorClassName(error);
      releaseTrace?.();
      return;
    }
    if (inTrace) return;
    void recordInOwnTrace(
      agentName,
      params,
      startedAt,
      startMs,
      (span) => fillStreamSpan(span, acc, params, error),
      error,
    ).catch(() => undefined);
  };

  let p: Promise<AnthropicMessageResponse>;
  try {
    p = original.call(self, params, prepareLlmCall(callOptions, detached?.span.span_id, propagate));
  } catch (err) {
    record(err);
    throw err;
  }
  onRejected(p, (err) => record(err));
  return mapKeepingShape(p, (stream) => {
    if (!stream || typeof stream !== "object") {
      record(undefined);
      return stream;
    }
    return wrapEventStream(
      stream as unknown as object,
      (event) => accumulateStreamEvent(acc, event),
      record,
    ) as unknown as AnthropicMessageResponse;
  }) as Promise<AnthropicMessageResponse>;
}

function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name || "Error" : typeof error;
}

/* ------------------------------------------------------------------------ */
/*  Public: deterministic segment extraction                                 */
/* ------------------------------------------------------------------------ */

/**
 * Maximum bytes of `content` we ship per segment. Long blobs are truncated
 * with `content_truncated: true`. The server further enforces its own
 * cap; we keep the SDK floor lower to stay friendly to mobile networks.
 */
export const MAX_SEGMENT_CONTENT_BYTES = 4096;

/**
 * Extract `ContextSegment[]` from an Anthropic `messages.create` request
 * + response. The ordering is:
 *
 *   1. `tools` → one `tool_descriptions` segment, position 0.
 *   2. `system` → `system_prompt` segment.
 *   3. Each prior `user` / `assistant` message → `chat_history` segment.
 *      `tool_result` blocks (always inside `user.content`) become their
 *      own `tool_observation` segments.
 *      `tool_use` blocks (assistant-emitted) roll into the parent
 *      assistant `chat_history` segment as part of the JSON content.
 *   4. The final `user` message → `current_input`.
 *
 * Cache state heuristic:
 *   - `system` blocks with `cache_control.type === "ephemeral"` →
 *     `cache_write`.
 *   - If the response reports `cache_read_input_tokens > 0`, mark the
 *     `system_prompt` and `tool_descriptions` segments as `cache_hit`
 *     (overrides `cache_write` — the cache HIT is more informative
 *     than the cache write attempt).
 *
 * `tokens` is intentionally left undefined — the server tokenizes.
 */
export function extractAnthropicSegments(
  params: AnthropicMessageCreateParams,
  response?: AnthropicMessageResponse,
): ContextSegment[] {
  const segments: ContextSegment[] = [];
  let position = 0;

  // 1. Tools → tool_descriptions.
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    const content = canonicalJsonStringify(params.tools);
    segments.push(makeSegment(position++, "tool_descriptions", content));
  }

  // 2. System.
  let systemHadEphemeral = false;
  if (params.system !== undefined && params.system !== null) {
    let text = "";
    if (typeof params.system === "string") {
      text = params.system;
    } else if (Array.isArray(params.system)) {
      const parts: string[] = [];
      for (const block of params.system) {
        if (block && typeof block === "object" && block.type === "text") {
          parts.push(typeof block.text === "string" ? block.text : "");
          if (
            block.cache_control &&
            typeof block.cache_control === "object" &&
            (block.cache_control as { type?: string }).type === "ephemeral"
          ) {
            systemHadEphemeral = true;
          }
        }
      }
      text = parts.join("\n");
    }
    const seg = makeSegment(position++, "system_prompt", text);
    if (systemHadEphemeral) seg.cache_state = "cache_write";
    segments.push(seg);
  }

  // 3 + 4. Walk messages.
  const messages = Array.isArray(params.messages) ? params.messages : [];
  // Identify the index of the LAST user message so we can route only it
  // to current_input. Earlier user messages are chat_history.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const blocks = normalizeContent(msg.content);
    // Tool-result blocks always emit their own tool_observation segments.
    const toolResults = blocks.filter(
      (b) => b.type === "tool_result",
    ) as AnthropicToolResultBlockParam[];
    const nonToolResults = blocks.filter((b) => b.type !== "tool_result");

    // The non-tool-result remainder belongs to either current_input,
    // chat_history, or, if empty, nothing.
    if (nonToolResults.length > 0) {
      const text = renderBlocksAsText(nonToolResults, msg.role);
      let source: string;
      if (msg.role === "user" && i === lastUserIdx) {
        source = "current_input";
      } else {
        source = "chat_history";
      }
      segments.push(makeSegment(position++, source, text));
    } else if (
      typeof msg.content === "string" &&
      msg.role === "user" &&
      i === lastUserIdx &&
      msg.content.length > 0
    ) {
      // Edge case: pure-string user message that's also the last user.
      segments.push(makeSegment(position++, "current_input", msg.content));
    }

    // Each tool_result emits its own segment, in order.
    for (const tr of toolResults) {
      const text = renderToolResult(tr);
      const seg = makeSegment(position++, "tool_observation", text);
      seg.attrs = { tool_use_id: tr.tool_use_id };
      if (tr.is_error) {
        (seg.attrs as Record<string, unknown>).is_error = true;
      }
      segments.push(seg);
    }
  }

  // Cache hit override.
  const cacheRead = response?.usage?.cache_read_input_tokens ?? 0;
  if (cacheRead > 0) {
    for (const seg of segments) {
      if (seg.source === "system_prompt" || seg.source === "tool_descriptions") {
        seg.cache_state = "cache_hit";
      }
    }
  }

  return segments;
}

function safeExtractSegments(
  params: AnthropicMessageCreateParams,
  response?: AnthropicMessageResponse,
): ContextSegment[] {
  try {
    return extractAnthropicSegments(params, response);
  } catch {
    return [];
  }
}

/**
 * MEM-11 — emit a sibling `memory`-type span linked to the given LLM span.
 *
 * The memory span:
 *   - `type = "memory"`
 *   - `parent_span_id = llmSpan.span_id` (server stores as producer_span_id)
 *   - `metadata.memory_op_type = "consolidate"`
 *   - `metadata.summary_token_count = response.usage.output_tokens`
 *   - `metadata.summary_content_hash = SHA-256 of response.content[0].text`
 *
 * Caller is responsible for catching exceptions — telemetry must never
 * break the customer's Anthropic call.
 */
function emitSummarizeMemorySpan(llmSpan: SpanData, response?: AnthropicMessageResponse): void {
  const state = getActiveTraceState();
  if (state === null) return;

  const summaryText = extractFirstTextBlock(response);
  const summaryHash = sha256Hex(summaryText);
  const summaryTokens = response?.usage?.output_tokens ?? 0;

  const startedAt = llmSpan.ended_at ?? llmSpan.started_at ?? nowIso();
  const memorySpan: SpanData = {
    trace_id: state.traceId,
    span_id: generateSpanId(),
    type: "memory",
    name: "anthropic.summarize",
    parent_span_id: llmSpan.span_id,
    started_at: startedAt,
    ended_at: startedAt,
    duration_ms: 0,
    status: "completed",
    metadata: {
      memory_op_type: "consolidate",
      summary_token_count: summaryTokens,
      summary_content_hash: summaryHash,
    },
  };
  state.completedSpans.push(memorySpan);
}

/**
 * Return the first text block of an Anthropic message response, or "" if
 * there is none. Best-effort; never throws.
 */
function extractFirstTextBlock(response?: AnthropicMessageResponse): string {
  try {
    const content = response?.content;
    if (!Array.isArray(content)) return "";
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string" && t.length > 0) return t;
      }
    }
    return "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------------ */
/*  Helpers — segment construction                                           */
/* ------------------------------------------------------------------------ */

function makeSegment(position: number, source: string, rawContent: string): ContextSegment {
  const fullHash = sha256Hex(rawContent);
  const truncated = truncateToBytes(rawContent, MAX_SEGMENT_CONTENT_BYTES);
  const seg: ContextSegment = {
    position,
    source,
    content_hash: fullHash,
    content: truncated.text,
    cache_state: "cold",
  };
  if (truncated.truncated) seg.content_truncated = true;
  return seg;
}

function normalizeContent(content: AnthropicMessageParam["content"]): AnthropicContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter((b): b is AnthropicContentBlockParam => !!b && typeof b === "object");
  }
  return [];
}

function renderBlocksAsText(blocks: AnthropicContentBlockParam[], role: string): string {
  // For chat_history / current_input we want a deterministic, hashable
  // string. Plain `text` blocks render as their text. `tool_use` blocks
  // render as a stable JSON marker so two equivalent calls hash the same.
  const out: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      const text = (b as AnthropicTextBlockParam).text;
      if (typeof text === "string") out.push(text);
    } else if (b.type === "tool_use") {
      const tu = b as AnthropicToolUseBlockParam;
      out.push(`[tool_use:${tu.name}:${tu.id}] ${canonicalJsonStringify(tu.input ?? null)}`);
    } else {
      // Unknown block type — best-effort serialize.
      out.push(canonicalJsonStringify(b));
    }
  }
  // Prefix with role for disambiguation in chat_history; keeps the
  // segment self-describing without bloating the hash too much.
  if (role === "assistant") {
    return out.length === 1 && out[0] !== undefined ? out[0] : out.join("\n");
  }
  return out.length === 1 && out[0] !== undefined ? out[0] : out.join("\n");
}

function renderToolResult(tr: AnthropicToolResultBlockParam): string {
  if (typeof tr.content === "string") return tr.content;
  if (Array.isArray(tr.content)) {
    const parts: string[] = [];
    for (const b of tr.content) {
      if (b && typeof b === "object") {
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
        else parts.push(canonicalJsonStringify(b));
      }
    }
    return parts.join("\n");
  }
  return "";
}

/* ------------------------------------------------------------------------ */
/*  Helpers — hashing + JSON canonicalization + byte truncation              */
/* ------------------------------------------------------------------------ */

/**
 * Stringify with stable key ordering so equivalent objects hash to the
 * same content_hash regardless of property insertion order.
 */
function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(value, function replacer(_key, val) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k];
      }
      return sorted;
    }
    return val;
  });
}

/**
 * Compute SHA-256 of `text` and return it hex-encoded. Tries Node's
 * `node:crypto` first (synchronous + zero-dep), falls back to a tiny
 * pure-TS impl when neither Node nor a Web Crypto sync API is available.
 *
 * NOTE: Web Crypto's `digest()` is async, but the segment-construction
 * path is sync. We therefore only use the Node sync API here. On the
 * browser we fall back to the pure-TS impl, which is fine for the
 * relatively short strings we hash (system prompts, tool defs, single
 * messages).
 */
function sha256Hex(text: string): string {
  // Strategy 1: Node's crypto.createHash. Sync and dep-free.
  try {
    if (typeof process !== "undefined" && process.versions?.node) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicRequire = Function("m", "return require(m)") as any as (m: string) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cryptoMod = dynamicRequire("node:crypto") as any;
      if (cryptoMod?.createHash) {
        return cryptoMod.createHash("sha256").update(text).digest("hex");
      }
    }
  } catch {
    // fall through
  }
  // Strategy 2: pure-TS sha256 (used in browsers).
  return purejsSha256(text);
}

function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  // Fast path: cheap upper bound. 1 char ≤ 4 bytes UTF-8.
  if (text.length <= maxBytes / 4) return { text, truncated: false };
  // Build the encoded bytes once.
  const bytes = utf8Encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Find the largest character boundary <= maxBytes.
  let cut = maxBytes;
  // Don't split a multi-byte sequence: walk back until we're at a
  // codepoint boundary (a byte where the top two bits aren't `10`).
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut--;
  }
  return { text: utf8Decode(bytes.subarray(0, cut)), truncated: true };
}

function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text);
  }
  // Pure-JS fallback. Should never trigger on Node 18+ or modern browsers.
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f),
      );
      i += 3;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/*  Pure-JS SHA-256 (used only when node:crypto is unavailable)              */
/* ------------------------------------------------------------------------ */

function purejsSha256(text: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // Pad message.
  const msg = utf8Encode(text);
  const msgLen = msg.length;
  const bitLen = msgLen * 8;
  const padded = new Uint8Array(((msgLen + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msgLen] = 0x80;
  // 64-bit big-endian length. JS bitwise ops are 32-bit, so split lo/hi via /.
  const lo = (bitLen & 0xffffffff) >>> 0;
  const hi = Math.floor(bitLen / 0x100000000) >>> 0;
  padded[padded.length - 8] = (hi >>> 24) & 0xff;
  padded[padded.length - 7] = (hi >>> 16) & 0xff;
  padded[padded.length - 6] = (hi >>> 8) & 0xff;
  padded[padded.length - 5] = hi & 0xff;
  padded[padded.length - 4] = (lo >>> 24) & 0xff;
  padded[padded.length - 3] = (lo >>> 16) & 0xff;
  padded[padded.length - 2] = (lo >>> 8) & 0xff;
  padded[padded.length - 1] = lo & 0xff;

  const W = new Uint32Array(64);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      // `>>> 0` forces unsigned — `(byte << 24)` otherwise produces a signed
      // int when the high bit is set, which corrupts the schedule on bytes ≥ 0x80.
      W[i] =
        ((padded[chunk + i * 4]! << 24) |
          (padded[chunk + i * 4 + 1]! << 16) |
          (padded[chunk + i * 4 + 2]! << 8) |
          padded[chunk + i * 4 + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + S1 + ch + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }

  let hex = "";
  for (const v of H) {
    hex += v.toString(16).padStart(8, "0");
  }
  return hex;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
