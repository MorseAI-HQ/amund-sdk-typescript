/**
 * The agent span a Claude Agent SDK run records (MHQ-1416, AID-01/02).
 *
 * The adapter used to open its own `anthropic-agent-sdk.agent` span inside
 * whatever trace was active: under `morse.run("name")` that was a second agent
 * span beneath the run's root, and outside `run()` the bridge trace's root plus
 * this span made two agent spans for one agent. With agent identity v2 the
 * trace root IS the agent: the run's model lands on the root span, an explicit
 * `defaultAgentName` is adopted as the framework root (so `run("app")` becomes
 * the `morse.app` label instead of a parent agent), and LLM / tool / sub-agent
 * spans parent straight to the root. `MORSE_AGENT_IDENTITY=legacy` keeps the
 * old extra span.
 */
import { isLegacyIdentity } from "../_internal/agent-name";
import type { SpanData } from "../_internal/spans";
import { adoptFrameworkRoot, getActiveTraceState, type SpanHandle } from "../_internal/tracing";
import { emitAgentSpan } from "../_agent-sdk-common/span-emitter";

export interface AgentScope {
  /** The span carrying the agent's model: the trace root, or the legacy span. */
  span: SpanData;
  /** Close the scope. A no-op for the trace root, which its trace closes. */
  end(error?: unknown): void;
}

export function openAgentScope(opts: {
  agentName: string;
  explicitAgentName?: string;
  model?: string;
}): AgentScope | null {
  if (isLegacyIdentity()) {
    return emitAgentSpan({
      adapter: "anthropic-agent-sdk",
      agentName: opts.agentName,
      model: opts.model,
    }) as SpanHandle | null;
  }
  try {
    const state = getActiveTraceState();
    const root = state?.spanStack[0];
    if (!state || !root) return null;
    adoptFrameworkRoot(opts.explicitAgentName);
    if (root.model === undefined && typeof opts.model === "string" && opts.model.length > 0) {
      root.model = opts.model;
    }
    return { span: root, end: () => undefined };
  } catch {
    return null;
  }
}
