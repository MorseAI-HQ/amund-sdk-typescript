/**
 * `@morsehq-dev/sdk/anthropic` — Anthropic SDK instrumentation.
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
import { setActiveFramework } from "../_internal/active-framework";
import { captureInputMessages, extractAnthropicOutputText } from "../_internal/llm-io";
import { getActiveTraceState, runAsync as _runAsync, startSpan } from "../_internal/tracing";

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
  if (globalInstallActive) return client;

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
    const installed = (mod as InstalledModule)[INSTALL_SENTINEL] === true;
    if (installed) {
      globalInstallActive = true;
      return true;
    }

    const carrier = findMessagesPrototypeCarrier(mod);
    if (!carrier) return false;
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
    (mod as InstalledModule)[ORIGINALS_SENTINEL] = {
      protoCreate: originalCreate,
      protoCarrier: carrier,
    };
    (mod as InstalledModule)[INSTALL_SENTINEL] = true;
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
    if (!anthropicModule || typeof anthropicModule !== "object") return;
    const mod = anthropicModule as InstalledModule;
    if (!mod[INSTALL_SENTINEL]) return;
    const originals = mod[ORIGINALS_SENTINEL];
    if (originals?.protoCarrier && originals.protoCreate !== undefined) {
      originals.protoCarrier.prototype.create =
        originals.protoCreate as typeof originals.protoCarrier.prototype.create;
    }
    mod[ORIGINALS_SENTINEL] = undefined;
    mod[INSTALL_SENTINEL] = false;
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
  if (explicit && typeof explicit === "object") return explicit;
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
  if (!mod || typeof mod !== "object") return null;
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

function buildPatchedCreate(
  original: (
    params: AnthropicMessageCreateParams,
    options?: unknown,
  ) => Promise<AnthropicMessageResponse>,
  options: InstrumentAnthropicOptions,
): (params: AnthropicMessageCreateParams, options?: unknown) => Promise<AnthropicMessageResponse> {
  const agentName = options.defaultAgentName;
  const summarizeMode = options.summarize === true;

  return async function patchedCreate(
    this: unknown,
    params: AnthropicMessageCreateParams,
    callOptions?: unknown,
  ): Promise<AnthropicMessageResponse> {
    const inTrace = getActiveTraceState() !== null;

    const work = async (): Promise<AnthropicMessageResponse> => {
      setActiveFramework("anthropic");
      const handle = startSpan({
        name: "anthropic.messages.create",
        type: "llm",
        metadata: { model: params?.model, max_tokens: params?.max_tokens },
      });
      let response: AnthropicMessageResponse | undefined;
      try {
        response = await original.call(this, params, callOptions);
      } catch (err) {
        handle?.end(err);
        throw err;
      }

      // Recording is best-effort — never let it throw at the caller.
      try {
        if (handle) {
          const segments = safeExtractSegments(params, response);
          const usage = response?.usage ?? {};
          const inputTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
          const outputTokens = usage.output_tokens ?? 0;
          handle.span.model = response?.model ?? params?.model;
          if (inputTokens > 0) handle.span.input_tokens = inputTokens;
          if (outputTokens > 0) handle.span.output_tokens = outputTokens;
          const cacheWrite = usage.cache_creation_input_tokens ?? 0;
          const cacheRead = usage.cache_read_input_tokens ?? 0;
          if (cacheWrite > 0) handle.span.cache_write_tokens = cacheWrite;
          if (cacheRead > 0) handle.span.cached_input_tokens = cacheRead;
          if (inputTokens > 0 || outputTokens > 0) {
            handle.span.total_tokens = inputTokens + outputTokens;
          }
          if (
            handle.span.cost_usd === undefined &&
            handle.span.model &&
            (inputTokens > 0 || outputTokens > 0)
          ) {
            const cost = calculateCost({
              inputTokens,
              outputTokens,
              model: handle.span.model,
              cachedInputTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
            });
            if (cost !== undefined) handle.span.cost_usd = cost;
          }
          handle.span.context_segments = segments;
          // MHQ-858: prompt/response capture, parity with Python's
          // `_safe_input_messages` / `_extract_output_text`.
          const inputData = captureInputMessages(params?.messages, params?.system);
          if (inputData !== undefined) handle.span.input_data = inputData;
          const outputText = extractAnthropicOutputText(response?.content);
          if (outputText !== undefined) handle.span.output_data = { content: outputText };
        }
      } catch {
        // swallow — telemetry must never break the caller
      }
      handle?.end();

      // MEM-11: emit sibling memory span when summarize mode is enabled.
      // Sequenced AFTER the LLM span closes so its span_id is final.
      if (summarizeMode && handle) {
        try {
          emitSummarizeMemorySpan(handle.span, response);
        } catch {
          // swallow — telemetry must never break the caller
        }
      }
      return response;
    };

    if (inTrace) {
      return work();
    }

    // No active trace — open a fresh agent span around the call so the
    // llm span has a parent. We can't return work()'s Promise from inside
    // _runAsync's callback while preserving the LLM result's typing AND
    // having the fresh trace own the lifecycle, so we wrap explicitly.
    let result: AnthropicMessageResponse | undefined;
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
    // result is set unless work() threw, in which case we already rethrew.
    return result as AnthropicMessageResponse;
  };
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
