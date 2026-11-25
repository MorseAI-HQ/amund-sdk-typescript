/**
 * `@amundai/sdk/openai-agents` — OpenAI Agents SDK runner wrapper.
 *
 * This module implements ONLY the outer-span (agent) instrumentation around
 * `Runner.run()`. Sibling files (`llm-and-tool.ts`, `handoff.ts`,
 * `guardrail.ts`) layer the inner llm / tool / handoff / guardrail spans;
 * Wave 3-O composes them via `src/openai-agents/index.ts`.
 *
 * Two entry points (mirroring `src/anthropic-agent-sdk/client-wrapper.ts`):
 *
 *   - `wrapRunner(runner)` — returns a Proxy that intercepts `run()` and
 *     opens an outer `agent` span around the returned Promise. The rest of
 *     the runner surface (`on`, `off`, anything else) is forwarded.
 *
 *   - `instrumentOpenAIAgents(runnerOrOptions, options?)` — two-mode
 *     installer. With a runner, equivalent to `wrapRunner`. With
 *     `{ openaiAgentsModule }`, best-effort patches
 *     `Runner.prototype.run`. Always returns the wrapped runner or a
 *     boolean; never throws.
 *
 * All telemetry paths are wrapped in `absorbErrors*` — a tracing failure
 * MUST NEVER break the customer's `run()`.
 */

import { absorbErrorsAsync, absorbErrorsSync } from "../_internal/errors";
import {
  adoptFrameworkRoot,
  adoptThreadId,
  getActiveTraceState,
  runAsync as _runAsync,
} from "../_internal/tracing";
import { isLegacyIdentity } from "../_internal/agent-name";
import { emitAgentSpan } from "../_agent-sdk-common/span-emitter";

import type { AgentLike, OpenAIAgentsModuleLike, RunResultLike, RunnerLike } from "./types";

/* ------------------------------------------------------------------------ */
/*  Module-level install sentinels                                           */
/* ------------------------------------------------------------------------ */

const WRAPPED_RUNNER = Symbol.for("morse.openai-agents.wrapped");
const INSTALL_SENTINEL = Symbol.for("morse.openai-agents.installed");
const ORIGINALS_SENTINEL = Symbol.for("morse.openai-agents.originals");

interface OriginalsBag {
  protoRun?: unknown;
  protoCarrier?: { prototype: { run: unknown } };
}

interface InstalledModule {
  [INSTALL_SENTINEL]?: boolean;
  [ORIGINALS_SENTINEL]?: OriginalsBag;
}

/* ------------------------------------------------------------------------ */
/*  Public API                                                               */
/* ------------------------------------------------------------------------ */

export interface WrapRunnerOptions {
  /** Override the agent name on the outer span when `agent.name` is absent. */
  defaultAgentName?: string;
  /**
   * MHQ-787: called with the resolved `RunResult` and the agent's
   * configured model after each `run()` succeeds, so callers can enrich
   * already-closed LLM spans with usage/model data that only becomes
   * available on the result (not on the SDK's own tracing spans). Never
   * called on a failed run. Errors from this callback are swallowed —
   * telemetry must never break the customer's `run()`.
   */
  onRunResult?: (result: RunResultLike, model: string | undefined) => void;
}

/**
 * Wrap a `Runner` so each `run()` call opens an outer `agent` span (via
 * `emitAgentSpan` from `_agent-sdk-common`). The Proxy forwards the rest
 * of the runner surface (event subscription via `on`/`off`, etc.) so
 * customers see no behavior change. Idempotent.
 *
 * THIS WRAPPER ONLY HANDLES THE OUTER AGENT SPAN. llm / tool / handoff /
 * guardrail spans are layered by sibling files (W2-O.2/.3/.4) and composed
 * via `src/openai-agents/index.ts` in Wave 3-O.
 */
export function wrapRunner<R extends RunnerLike>(runner: R, options: WrapRunnerOptions = {}): R {
  if (!runner || typeof runner !== "object") return runner;
  if ((runner as Record<string | symbol, unknown>)[WRAPPED_RUNNER]) return runner;

  const originalRun = runner.run?.bind(runner);
  if (typeof originalRun !== "function") return runner;

  const patchedRun = buildPatchedRun(
    originalRun as (
      agent: AgentLike,
      input: unknown,
      callOptions?: Record<string, unknown>,
    ) => Promise<RunResultLike>,
    options,
  );

  const wrapper = new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === WRAPPED_RUNNER) return true;
      if (prop === "run") return patchedRun;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...a: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });

  return wrapper as R;
}

export interface InstrumentOpenAIAgentsOptions extends WrapRunnerOptions {
  openaiAgentsModule?: unknown;
}

type InstrumentRunnerArg = RunnerLike | InstrumentOpenAIAgentsOptions | undefined;

/**
 * Top-level installer. Two modes:
 *
 *   - `instrumentOpenAIAgents(runner)` — equivalent to `wrapRunner(runner)`.
 *   - `instrumentOpenAIAgents({ openaiAgentsModule: mod })` — best-effort
 *     prototype patch on `Runner.prototype.run`. Prefer the wrap form when
 *     possible.
 *
 * Always returns the wrapped runner, `true`/`false` for the module path, or
 * `undefined` on absorbed error. Never throws.
 */
export const instrumentOpenAIAgents: (
  runnerOrOptions?: InstrumentRunnerArg,
  maybeOptions?: WrapRunnerOptions,
) => Promise<unknown> = absorbErrorsAsync(
  async (
    runnerOrOptions: InstrumentRunnerArg = undefined,
    maybeOptions: WrapRunnerOptions = {},
  ): Promise<unknown> => {
    if (runnerOrOptions && isRunner(runnerOrOptions)) {
      const opts = maybeOptions ?? {};
      return wrapRunner(runnerOrOptions, opts);
    }
    const opts = (runnerOrOptions as InstrumentOpenAIAgentsOptions | undefined) ?? {};
    const mod = await loadOpenAIAgentsModule(opts.openaiAgentsModule);
    if (!mod) return false;
    const installed = (mod as InstalledModule)[INSTALL_SENTINEL] === true;
    if (installed) return true;

    const carrier = findRunnerPrototypeCarrier(mod);
    if (!carrier) return false;
    const originalRun = carrier.prototype.run;
    if (typeof originalRun !== "function") return false;

    const patchedRun = buildPatchedRun(function (
      this: unknown,
      agent: AgentLike,
      input: unknown,
      callOptions?: Record<string, unknown>,
    ) {
      return (originalRun as (...args: unknown[]) => Promise<RunResultLike>).call(
        this,
        agent,
        input,
        callOptions,
      );
    }, opts);
    carrier.prototype.run = patchedRun as unknown as typeof carrier.prototype.run;
    (mod as InstalledModule)[ORIGINALS_SENTINEL] = {
      protoRun: originalRun,
      protoCarrier: carrier,
    };
    (mod as InstalledModule)[INSTALL_SENTINEL] = true;
    return true;
  },
  { fingerprint: "morse.adapters.openai-agents.install" },
);

/**
 * Restore the prototype patch and clear the install sentinel. Pass the same
 * module reference given to `instrumentOpenAIAgents`. No-op when called with
 * no module or on a wrapped-runner (vs. module) install — just discard the
 * wrapper.
 */
export const uninstallOpenAIAgents: (openaiAgentsModule?: unknown) => void = absorbErrorsSync(
  (openaiAgentsModule?: unknown): void => {
    if (!openaiAgentsModule || typeof openaiAgentsModule !== "object") return;
    const mod = openaiAgentsModule as InstalledModule;
    if (!mod[INSTALL_SENTINEL]) return;
    const originals = mod[ORIGINALS_SENTINEL];
    if (originals?.protoCarrier && originals.protoRun !== undefined) {
      originals.protoCarrier.prototype.run =
        originals.protoRun as typeof originals.protoCarrier.prototype.run;
    }
    mod[ORIGINALS_SENTINEL] = undefined;
    mod[INSTALL_SENTINEL] = false;
  },
  { fingerprint: "morse.adapters.openai-agents.uninstall" },
) as (openaiAgentsModule?: unknown) => void;

/** True when a wrapped OpenAI Agents `Runner` is passed in. */
export function isOpenAIAgentsWrapped(runner: unknown): boolean {
  if (!runner || typeof runner !== "object") return false;
  return (runner as Record<string | symbol, unknown>)[WRAPPED_RUNNER] === true;
}

/* ------------------------------------------------------------------------ */
/*  Internals — module discovery                                             */
/* ------------------------------------------------------------------------ */

function isRunner(x: unknown): x is RunnerLike {
  if (!x || typeof x !== "object") return false;
  const r = (x as { run?: unknown }).run;
  return typeof r === "function";
}

async function loadOpenAIAgentsModule(explicit?: unknown): Promise<unknown | null> {
  if (explicit && typeof explicit === "object") return explicit;
  try {
    // Function-eval'd dynamic import keeps bundlers from trying to resolve
    // `@openai/agents` at build time when the dep isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (Function("m", "return import(m)") as any)("@openai/agents");
  } catch {
    return null;
  }
}

/**
 * Locate `Runner.prototype` on the OpenAI Agents module. The SDK exposes
 * the class at slightly different paths across versions; try the most
 * common shapes.
 */
function findRunnerPrototypeCarrier(mod: unknown): { prototype: { run: unknown } } | null {
  if (!mod || typeof mod !== "object") return null;
  const m = mod as OpenAIAgentsModuleLike & Record<string, unknown>;
  const candidates: unknown[] = [m.Runner, (m.default as { Runner?: unknown } | undefined)?.Runner];
  for (const c of candidates) {
    if (
      c &&
      typeof c === "function" &&
      (c as { prototype?: { run?: unknown } }).prototype &&
      typeof (c as { prototype: { run?: unknown } }).prototype.run === "function"
    ) {
      return c as { prototype: { run: unknown } };
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/*  Internals — wrapper that opens the outer `agent` span                    */
/* ------------------------------------------------------------------------ */

function stringifyModel(m: AgentLike["model"]): string | undefined {
  if (typeof m === "string" && m.length > 0) return m;
  if (m && typeof m === "object" && typeof m.id === "string" && m.id.length > 0) return m.id;
  return undefined;
}

/**
 * Find the conversation identity for one `run()` call, or undefined. (MHQ-1029)
 *
 * Checked in order of how explicit the signal is:
 *
 * 1. `session` — the Agents SDK's own multi-turn primitive.
 * 2. `conversationId` — the OpenAI Conversations API thread.
 * 3. `context` — the app's run context. ChatKit hangs the thread off
 *    `context.thread.id` (`thr_…`); apps that roll their own context usually
 *    name the field `threadId`/`sessionId`/`conversationId`. This is the case
 *    the Python ticket was filed for: the app's only integration is the SDK's
 *    auto-install, so the id comes off the context or not at all.
 *
 * Every read can run customer getter code, hence the blanket guard.
 */
function resolveThreadId(callOptions: Record<string, unknown> | undefined): unknown {
  if (!callOptions) return undefined;
  try {
    const session = callOptions.session as
      | { sessionId?: unknown; session_id?: unknown }
      | undefined;
    if (session) {
      const sid = session.sessionId ?? session.session_id;
      if (sid) return sid;
    }
    if (callOptions.conversationId) return callOptions.conversationId;
    const ctx = callOptions.context as Record<string, unknown> | undefined;
    if (!ctx || typeof ctx !== "object") return undefined;
    const threadPk = (ctx.thread as { id?: unknown } | undefined)?.id;
    if (threadPk) return threadPk;
    for (const key of ["threadId", "thread_id", "sessionId", "session_id", "conversationId"]) {
      if (ctx[key]) return ctx[key];
    }
  } catch {
    /* telemetry must never throw at the caller */
  }
  return undefined;
}

function buildPatchedRun(
  original: (
    agent: AgentLike,
    input: unknown,
    callOptions?: Record<string, unknown>,
  ) => Promise<RunResultLike>,
  options: WrapRunnerOptions,
): (
  agent: AgentLike,
  input: unknown,
  callOptions?: Record<string, unknown>,
) => Promise<RunResultLike> {
  return function patchedRun(
    this: unknown,
    agent: AgentLike,
    input: unknown,
    callOptions?: Record<string, unknown>,
  ): Promise<RunResultLike> {
    const boundOriginal = (
      a: AgentLike,
      i: unknown,
      o?: Record<string, unknown>,
    ): Promise<RunResultLike> => original.call(this, a, i, o);

    // MHQ-1100: the starting agent's own name is framework-native; the
    // "openai-agent" placeholder is gone so env/script tiers can win.
    const frameworkAgentName =
      agent && typeof agent === "object" && typeof agent.name === "string" && agent.name.length > 0
        ? agent.name
        : undefined;
    const agentName = frameworkAgentName ?? options.defaultAgentName ?? "openai-agent";
    const model = stringifyModel(agent?.model);

    const runWithSpan = async (): Promise<RunResultLike> => {
      adoptThreadId(resolveThreadId(callOptions));
      // AID-01/02: the starting agent is the trace root, recorded once via the trace
      // processor. Legacy mode keeps this wrapper's own agent span.
      const legacy = isLegacyIdentity();
      if (!legacy) adoptFrameworkRoot(options.defaultAgentName ?? frameworkAgentName);
      const handle = legacy
        ? emitAgentSpan({
            adapter: "openai-agents",
            agentName,
            model,
          })
        : null;
      try {
        const result = await boundOriginal(agent, input, callOptions);
        try {
          options.onRunResult?.(result, model);
        } catch {
          /* telemetry must never throw at the caller */
        }
        handle?.end();
        return result;
      } catch (err) {
        handle?.end(err);
        throw err;
      }
    };

    // If we're already inside an active trace, the agent span attaches as a
    // child of the existing root. Otherwise, open a fresh trace so the span
    // has a parent — without this, `emitAgentSpan` would no-op (return null)
    // and the customer would see no telemetry.
    if (getActiveTraceState() !== null) {
      return runWithSpan();
    }

    return (async (): Promise<RunResultLike> => {
      let captured: RunResultLike | undefined;
      let caughtErr: unknown;
      const runResult = await _runAsync(
        { agentName: options.defaultAgentName, frameworkAgentName },
        async (runHandle) => {
          try {
            captured = await runWithSpan();
            runHandle.setOutcome(true);
            return captured;
          } catch (err) {
            caughtErr = err;
            throw err;
          }
        },
      ).catch((err) => {
        // _runAsync rethrows; capture so we can rethrow after the trace
        // flush completes. The trace is already finalized as failed by
        // _runAsync's catch path.
        if (caughtErr === undefined) caughtErr = err;
        return undefined;
      });

      if (caughtErr !== undefined) throw caughtErr;
      // `runResult` is the value returned by the inner fn (i.e. `captured`),
      // but prefer the captured local for type-safety.
      return (captured ?? runResult) as RunResultLike;
    })();
  };
}
