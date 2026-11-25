/**
 * `@amund/sdk/openai-agents` — adapter for `@openai/agents`.
 *
 * Wave 3-O composes the W2-O surfaces (`runner-wrapper`, `llm-and-tool`,
 * `handoff`, `guardrail`) into a single public entry point.
 *
 * Two usage modes:
 *
 *   1. **Granular** — import any of the four installers individually and
 *      compose them yourself (`wrapRunner`, `installLlmAndToolInstrumentation`,
 *      `installHandoffInstrumentation`, `installGuardrailInstrumentation`).
 *
 *   2. **Full convenience** — call `wrapRunnerWithFullInstrumentation(runner)`
 *      to get an outer-span-wrapped Runner with llm + tool + handoff +
 *      guardrail event listeners pre-installed, plus a single `dispose()`
 *      that unsubscribes all three event installers.
 *
 * See `openspec/changes/2026-05-26-phase-13-ts-agent-sdk-adapters/`.
 */

import { wrapRunner } from "./runner-wrapper";
import { installLlmAndToolInstrumentation } from "./llm-and-tool";
import { installHandoffInstrumentation } from "./handoff";
import { installGuardrailInstrumentation } from "./guardrail";
import { MorseTraceProcessor, installMorseTraceProcessor } from "./trace-processor";

import type { RunnerLike } from "./types";

export type {
  AgentLike,
  OpenAIAgentsModuleLike,
  RunResultLike,
  RunnerEventLike,
  RunnerLike,
} from "./types";

export {
  instrumentOpenAIAgents,
  isOpenAIAgentsWrapped,
  uninstallOpenAIAgents,
  wrapRunner,
} from "./runner-wrapper";
export { installLlmAndToolInstrumentation } from "./llm-and-tool";
export { installHandoffInstrumentation } from "./handoff";
export { installGuardrailInstrumentation } from "./guardrail";
export { MorseTraceProcessor, installMorseTraceProcessor } from "./trace-processor";
export type {
  MorseTraceProcessorOptions,
  AgentsModuleLike,
  OpenAISpanLike,
  OpenAITraceLike,
} from "./trace-processor";

/* ------------------------------------------------------------------------ */
/*  Composed convenience installer                                           */
/* ------------------------------------------------------------------------ */

export interface FullOpenAIInstrumentationOptions {
  /** Override the agent name on the outer span when `agent.name` is absent. */
  defaultAgentName?: string;
  /** Max bytes for serialized tool input summary. */
  toolInputMaxBytes?: number;
  /** Max bytes for serialized tool output summary. */
  toolOutputMaxBytes?: number;
}

/**
 * Wrap an OpenAI Agents `Runner` with the full instrumentation stack:
 *
 *   1. Outer `agent` span via `wrapRunner` (provides the trace context).
 *   2. SDK-native span translation via `MorseTraceProcessor`
 *      registered through the SDK's `addTraceProcessor()` pipeline —
 *      catches `agent` / `response` / `generation` / `function` /
 *      `handoff` / `guardrail` / `mcp_list_tools` / `custom` spans.
 *   3. Legacy event-listener installers (`installLlmAndToolInstrumentation`,
 *      `installHandoffInstrumentation`, `installGuardrailInstrumentation`)
 *      remain wired as no-ops when the real SDK doesn't expose a
 *      `runner.on()` channel — they only fire against the mock fixture
 *      in unit tests. Real-SDK usage flows through the TraceProcessor.
 *
 * Returns the wrapped runner and a single `dispose()` that unsubscribes
 * the legacy event installers. The TraceProcessor stays registered for
 * the lifetime of the process — the SDK's `addTraceProcessor` API has no
 * symmetric `removeTraceProcessor` (you'd have to `setTraceProcessors([])`
 * which would nuke any other processors too).
 *
 * Telemetry failures NEVER propagate to the host — every emission path
 * is wrapped in `absorbErrorsSync` upstream.
 */
export function wrapRunnerWithFullInstrumentation<R extends RunnerLike>(
  runner: R,
  options: FullOpenAIInstrumentationOptions = {},
): { runner: R; dispose: () => void } {
  // Fire-and-forget: install the TraceProcessor with the real SDK if it's
  // resolvable. Failure is silent (e.g., the customer is running tests
  // with a mocked SDK, or hasn't installed `@openai/agents` at all).
  // Declared before `wrapRunner` below so `onRunResult` can close over it —
  // by the time a real run() resolves (a live model round trip), this
  // fire-and-forget install has virtually always finished; if it somehow
  // hasn't, enrichment is just skipped for that run (never throws).
  let installedProcessor: MorseTraceProcessor | null = null;

  const wrapped = wrapRunner(runner, {
    defaultAgentName: options.defaultAgentName,
    // MHQ-787: the SDK's own tracing spans for the Responses-API path
    // carry no model/usage — only the resolved RunResult does. Patch
    // already-closed LLM spans once we have it.
    onRunResult: (result, model) => {
      const rawResponses = (result as { rawResponses?: unknown }).rawResponses;
      if (installedProcessor && Array.isArray(rawResponses)) {
        installedProcessor.enrichFromRunResult(
          rawResponses as Parameters<MorseTraceProcessor["enrichFromRunResult"]>[0],
          model,
        );
      }
    },
  });

  const llmAndToolOpts: {
    toolInputMaxBytes?: number;
    toolOutputMaxBytes?: number;
  } = {};
  if (options.toolInputMaxBytes !== undefined) {
    llmAndToolOpts.toolInputMaxBytes = options.toolInputMaxBytes;
  }
  if (options.toolOutputMaxBytes !== undefined) {
    llmAndToolOpts.toolOutputMaxBytes = options.toolOutputMaxBytes;
  }

  const offLlmTool = installLlmAndToolInstrumentation(wrapped, llmAndToolOpts);
  const offHandoff = installHandoffInstrumentation(wrapped);
  const offGuardrail = installGuardrailInstrumentation(wrapped);

  void installMorseTraceProcessor(llmAndToolOpts).then((result) => {
    if (result.installed) {
      installedProcessor = result.processor;
    }
  });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      offLlmTool();
    } catch {
      /* telemetry must never throw at the caller */
    }
    try {
      offHandoff();
    } catch {
      /* telemetry must never throw at the caller */
    }
    try {
      offGuardrail();
    } catch {
      /* telemetry must never throw at the caller */
    }
    // Best-effort: drain any in-flight spans the processor still holds.
    if (installedProcessor) {
      try {
        void installedProcessor.shutdown();
      } catch {
        /* never propagate */
      }
    }
  };

  return { runner: wrapped, dispose };
}
