/**
 * MHQ-859 — active framework discovery, the TS half of AGE-240.
 *
 * Python has had this since AGE-240: each adapter marks itself active when
 * it intercepts a call, the trace stamps `morse_ai.framework` on its
 * resource, and the server uses it to disambiguate agents that share a
 * logical name but not an implementation. TypeScript had the *consumer*
 * side wired all along — `otel-provider.ts` already maps
 * `resource["morse_ai.framework"]` to the `morse.framework` root-span
 * attribute — but nothing ever set it, so every TS trace landed with
 * `framework` NULL and framework filtering silently excluded all TS traffic.
 *
 * Python uses a `threading.local`. The Node equivalent is per-trace state,
 * not per-thread: `AsyncLocalStorage` already scopes the active trace, and
 * concurrent traces in one process must not see each other's marker. So the
 * marker is written straight onto the active trace state and there is no
 * module-global to leak across interleaved async calls — which also removes
 * the need for Python's `clear_active_framework()` try/finally discipline.
 *
 * First framework wins per trace: when a customer mixes two adapters in one
 * trace, the first to fire defines the label. Absence is the signal — never
 * invent a default.
 */

import { getActiveTraceState } from "./tracing";

/**
 * Mark `name` as the framework for the currently-active trace.
 *
 * No-op when no trace is active (an adapter can fire outside `run()`), and
 * no-op when a framework is already set. Never throws — telemetry must not
 * break customer code.
 */
export function setActiveFramework(name: string): void {
  if (typeof name !== "string" || name.length === 0) return;
  try {
    const state = getActiveTraceState();
    if (state !== null && !state.framework) {
      state.framework = name;
    }
  } catch {
    // swallow — never break the caller
  }
}

/** Framework recorded on the active trace, or `undefined`. */
export function getActiveFramework(): string | undefined {
  try {
    return getActiveTraceState()?.framework ?? undefined;
  } catch {
    return undefined;
  }
}
