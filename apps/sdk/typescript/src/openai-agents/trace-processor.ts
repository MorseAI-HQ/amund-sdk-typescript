/**
 * `openai-agents/trace-processor.ts` — translate `@openai/agents` SDK spans
 * into Morse spans via the SDK's first-class TraceProcessor pipeline.
 *
 * The SDK exposes `addTraceProcessor(p)` / `setTraceProcessors([p])` where
 * `p` implements:
 *
 *   - `onTraceStart(trace)`
 *   - `onTraceEnd(trace)`
 *   - `onSpanStart(span)`
 *   - `onSpanEnd(span)`
 *   - `shutdown()`
 *   - `forceFlush()`
 *
 * Each `span` carries `span.spanId` + `span.spanData.{type,name,model,usage,...}`.
 * Span types observed in the SDK: `agent`, `response`, `generation`,
 * `function`, `handoff`, `guardrail`, `mcp_list_tools`, `custom`.
 *
 * **Why this exists.** The original W2-O surfaces in this directory
 * (llm-and-tool.ts, handoff.ts, guardrail.ts) listened to a hypothetical
 * `runner.on('llm_call_start', ...)` event channel that the real SDK
 * doesn't expose. Phase 13 Option A dogfood (commit 9e53731) confirmed
 * the old installers never fired. This TraceProcessor is the canonical
 * replacement — see `openspec/changes/2026-05-26-phase-13-ts-agent-sdk-adapters/`.
 *
 * **Telemetry containment.** Every processor method is wrapped — a
 * translation failure must never bubble back into the customer's
 * Runner.run().
 */

import { summarizeToolInput, summarizeToolOutput } from "../_agent-sdk-common/redaction";
import {
  emitAgentSpan,
  emitLlmSpan,
  emitSubagentSpan,
  emitToolSpan,
} from "../_agent-sdk-common/span-emitter";
import { calculateCost } from "../_internal/pricing";
import type { SpanHandle } from "../_internal/tracing";
import { report } from "../_internal/diagnostics";

const ADAPTER = "openai-agents" as const;

/**
 * Structural shape of a span passed to the processor. We avoid importing
 * the real SDK types so this file builds without `@openai/agents` installed.
 */
export interface OpenAISpanLike {
  spanId?: string;
  parentId?: string;
  traceId?: string;
  spanData?: {
    type?: string;
    name?: string;
    model?: string;
    input?: unknown;
    output?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      [k: string]: unknown;
    };
    // handoff
    from_agent?: string;
    to_agent?: string;
    // guardrail
    passed?: boolean;
    reason?: string;
    [k: string]: unknown;
  };
  error?: unknown;
  [k: string]: unknown;
}

export interface OpenAITraceLike {
  traceId?: string;
  name?: string;
  [k: string]: unknown;
}

export interface MorseTraceProcessorOptions {
  toolInputMaxBytes?: number;
  toolOutputMaxBytes?: number;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Translate OpenAI Agents SDK spans into Morse spans.
 *
 * Pass to the SDK via `addTraceProcessor(new MorseTraceProcessor())`
 * (or via `wrapRunnerWithFullInstrumentation` which installs it for you).
 *
 * The processor is idempotent: registering the same instance twice is
 * harmless. Multiple instances can coexist (each will translate spans
 * independently — useful if you need to fan out to several backends).
 */
export class MorseTraceProcessor {
  private readonly options: MorseTraceProcessorOptions;
  private readonly openSpans = new Map<string, SpanHandle>();
  /**
   * MHQ-787: `'response'`-type spans (the SDK's default Responses-API path)
   * carry a `response_id` but no `model`/`usage` of their own — that data
   * only becomes available on `Runner.run()`'s resolved result
   * (`result.rawResponses`), which arrives AFTER `onSpanEnd` already fired.
   * Keep already-closed response spans around, keyed by `response_id`, so
   * `enrichFromRunResult()` can patch them in place once the real usage
   * data is available. Spans stay mutable (their span-tree object isn't
   * exported until the outer trace closes), so a late patch still lands.
   */
  private readonly closedResponseSpans = new Map<string, SpanHandle>();

  constructor(options: MorseTraceProcessorOptions = {}) {
    this.options = options;
  }

  /**
   * MHQ-787: called by `wrapRunnerWithFullInstrumentation` after each
   * `Runner.run()` resolves. Matches `rawResponses[].responseId` back to
   * the `'response'`-type span it belongs to and fills in the model/usage/
   * cost fields `onSpanEnd` couldn't populate at the time. `fallbackModel`
   * is the model configured on the `Agent` (known at call time in
   * `runner-wrapper.ts`) — used only when the span still has no model.
   * Never throws; a translation failure must not surface to the caller.
   */
  enrichFromRunResult(
    rawResponses: Array<{
      responseId?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      // MHQ-926: the model actually served. `@openai/agents` does not surface
      // it as `raw.model` — it sits under `providerData`, straight off the
      // Responses API payload.
      providerData?: { model?: string; [k: string]: unknown };
    }>,
    fallbackModel?: string,
  ): void {
    safe(() => {
      for (const raw of rawResponses) {
        if (typeof raw.responseId !== "string") continue;
        const handle = this.closedResponseSpans.get(raw.responseId);
        if (!handle) continue;
        this.closedResponseSpans.delete(raw.responseId);

        // MHQ-926: prefer the model the provider actually served over the one
        // configured on the Agent. `new Agent({ name, instructions })` leaves
        // `agent.model` as the EMPTY STRING when the caller relies on the SDK
        // default — falsy, so `fallbackModel` contributed nothing and the span
        // stayed `model: "unknown"`, which made `calculateCost` return
        // undefined and every openai-agents llm span land with a null
        // `cost_usd`. Relying on the SDK's default model is the common case,
        // so this was not an edge case.
        //
        // `providerData.model` is also strictly better than the configured
        // value even when one is set: it is the dated id that was billed
        // (`gpt-5.4-mini-2026-03-17`), and the pricing table normalises dated
        // ids back to their base entry.
        const servedModel =
          typeof raw.providerData?.model === "string" && raw.providerData.model.length > 0
            ? raw.providerData.model
            : undefined;
        if (!handle.span.model || handle.span.model === "unknown") {
          const resolved = servedModel ?? fallbackModel;
          if (resolved) handle.span.model = resolved;
        }

        const u = raw.usage;
        if (u) {
          if (typeof u.inputTokens === "number") handle.span.input_tokens = u.inputTokens;
          if (typeof u.outputTokens === "number") handle.span.output_tokens = u.outputTokens;
          if (typeof u.totalTokens === "number") {
            handle.span.total_tokens = u.totalTokens;
          } else if (
            handle.span.input_tokens !== undefined &&
            handle.span.output_tokens !== undefined
          ) {
            handle.span.total_tokens = handle.span.input_tokens + handle.span.output_tokens;
          }
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
    });
  }

  /* -- TraceProcessor surface ---------------------------------------- */

  onTraceStart(_trace: OpenAITraceLike): void {
    // No-op: `wrapRunnerWithFullInstrumentation`'s outer `wrapRunner`
    // call already opens an agent span for the run. The SDK's trace
    // boundary is informational.
    void _trace;
  }

  onTraceEnd(_trace: OpenAITraceLike): void {
    void _trace;
  }

  onSpanStart(span: OpenAISpanLike): void {
    safe(() => {
      const handle = this.openSpanFor(span);
      if (handle && span.spanId) {
        this.openSpans.set(span.spanId, handle);
      }
    });
  }

  onSpanEnd(span: OpenAISpanLike): void {
    safe(() => {
      if (!span.spanId) return;
      const handle = this.openSpans.get(span.spanId);
      if (!handle) return;
      this.openSpans.delete(span.spanId);
      this.populateSpanFromData(handle, span);

      const d = span.spanData;
      if (d?.type === "response" && typeof d.response_id === "string" && d.response_id.length > 0) {
        this.closedResponseSpans.set(d.response_id, handle);
      }
      if (d?.type === "guardrail" && d.passed === false) {
        safeEnd(handle, new Error(`guardrail failed: ${d.reason ?? "no reason"}`));
        return;
      }
      if (span.error) {
        safeEnd(handle, new Error(String(span.error)));
        return;
      }
      safeEnd(handle);
    });
  }

  async shutdown(): Promise<void> {
    // Close any still-open spans (the customer's process is exiting).
    for (const [, handle] of this.openSpans) {
      safeEnd(handle, new Error("morse: processor shutdown before span ended"));
    }
    this.openSpans.clear();
    this.closedResponseSpans.clear();
  }

  async forceFlush(): Promise<void> {
    // No internal buffer — flushing is the underlying SDK's responsibility.
  }

  /* -- Internals ------------------------------------------------------ */

  private openSpanFor(span: OpenAISpanLike): SpanHandle | null {
    const d = span.spanData ?? {};
    const type = typeof d.type === "string" ? d.type : "";
    const name = typeof d.name === "string" && d.name.length > 0 ? d.name : undefined;

    switch (type) {
      case "agent":
        return emitAgentSpan({
          adapter: ADAPTER,
          agentName: name ?? "openai-agent",
        });

      case "generation":
      case "response": {
        // Model + usage are typically only known at end; populate from
        // openSpanFor for what we have now, fill the rest in populateSpanFromData.
        const model = typeof d.model === "string" && d.model.length > 0 ? d.model : "unknown";
        return emitLlmSpan({ adapter: ADAPTER, model });
      }

      case "function": {
        const inputOpts = this.options.toolInputMaxBytes
          ? { maxBytes: this.options.toolInputMaxBytes }
          : undefined;
        return emitToolSpan({
          adapter: ADAPTER,
          toolName: name ?? "function",
          inputSummary: d.input !== undefined ? summarizeToolInput(d.input, inputOpts) : undefined,
        });
      }

      case "handoff":
        return emitSubagentSpan({
          adapter: ADAPTER,
          parentAgentName: typeof d.from_agent === "string" ? d.from_agent : "unknown",
          subagentName: typeof d.to_agent === "string" ? d.to_agent : (name ?? "unknown"),
          taskDescription: typeof d.reason === "string" ? d.reason : undefined,
        });

      case "guardrail": {
        const handle = emitToolSpan({
          adapter: ADAPTER,
          toolName: `guardrail.${name ?? "anon"}`,
        });
        if (handle) {
          handle.span.metadata = {
            ...(handle.span.metadata ?? {}),
            tool_kind: "guardrail",
            guardrail: {
              name: name ?? "anon",
              passed: d.passed,
              ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
            },
          };
        }
        return handle;
      }

      case "mcp_list_tools":
        return emitToolSpan({
          adapter: ADAPTER,
          toolName: `mcp.list_tools.${name ?? "anon"}`,
        });

      case "custom":
        // Custom spans are user-defined; pass through as a generic tool span
        // so they appear in the trace without us guessing semantics.
        return emitToolSpan({
          adapter: ADAPTER,
          toolName: `custom.${name ?? "anon"}`,
        });

      default:
        // Unknown type — emit a tool span tagged with the raw type so we
        // can spot SDK additions in the dashboard rather than silently dropping.
        return emitToolSpan({
          adapter: ADAPTER,
          toolName: `${type || "unknown"}.${name ?? "anon"}`,
        });
    }
  }

  private populateSpanFromData(handle: SpanHandle, span: OpenAISpanLike): void {
    const d = span.spanData;
    if (!d) return;

    if (typeof d.model === "string" && d.model.length > 0) {
      handle.span.model = d.model;
    }

    const u = d.usage;
    if (u) {
      const input = u.input_tokens ?? u.prompt_tokens;
      const output = u.output_tokens ?? u.completion_tokens;
      const total = u.total_tokens;
      if (typeof input === "number") handle.span.input_tokens = input;
      if (typeof output === "number") handle.span.output_tokens = output;
      if (typeof total === "number") {
        handle.span.total_tokens = total;
      } else if (typeof input === "number" && typeof output === "number") {
        handle.span.total_tokens = input + output;
      }
    }

    if (d.output !== undefined) {
      const outputOpts = this.options.toolOutputMaxBytes
        ? { maxBytes: this.options.toolOutputMaxBytes }
        : undefined;
      handle.span.metadata = {
        ...(handle.span.metadata ?? {}),
        tool_output_summary: summarizeToolOutput(d.output, outputOpts),
      };
    }
  }
}

/* ------------------------------------------------------------------------ */
/*  Module loader — best-effort registration with the real SDK              */
/* ------------------------------------------------------------------------ */

export interface AgentsModuleLike {
  addTraceProcessor?(processor: unknown): void;
  setTraceProcessors?(processors: unknown[]): void;
}

/**
 * Best-effort installation of an MorseTraceProcessor with the real
 * `@openai/agents` SDK. Returns true if installation succeeded.
 *
 * Loads the module via runtime-eval'd dynamic import so the SDK is a
 * pure optional peer dep — bundlers won't try to resolve it at build
 * time when the customer hasn't installed it.
 *
 * Idempotent at the registration level: the SDK's `addTraceProcessor`
 * appends to a list, so calling this twice will install two processors.
 * Production callers should call once at app bootstrap.
 */
export async function installMorseTraceProcessor(
  options?: MorseTraceProcessorOptions,
): Promise<{ installed: boolean; processor: MorseTraceProcessor | null }> {
  const processor = new MorseTraceProcessor(options);
  let mod: AgentsModuleLike | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dynamicImport = Function("m", "return import(m)") as any as (
      m: string,
    ) => Promise<AgentsModuleLike>;
    mod = await dynamicImport("@openai/agents");
  } catch {
    return { installed: false, processor: null };
  }
  try {
    if (typeof mod?.addTraceProcessor === "function") {
      mod.addTraceProcessor(processor);
      return { installed: true, processor };
    }
  } catch {
    // fall through
  }
  return { installed: false, processor: null };
}

function safeEnd(handle: SpanHandle, err?: unknown): void {
  try {
    if (err !== undefined) {
      handle.end(err);
    } else {
      handle.end();
    }
  } catch (err) {
    /* never propagate */
    reportSwallowed(err, "morse.openai_agents.trace_processor");
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
