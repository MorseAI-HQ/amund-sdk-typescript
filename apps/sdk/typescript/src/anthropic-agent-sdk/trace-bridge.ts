/**
 * Bridge an async generator into a fresh Morse trace.
 *
 * `emitAgentSpan` no-ops (returns `null`) when there is no active trace, so an
 * adapter invoked outside `morse.run()` would emit nothing at all. Both
 * entry points for `@anthropic-ai/claude-agent-sdk` need the same fix: if a
 * trace is already active, attach to it; otherwise open one whose lifetime is
 * bound to the iteration, not to the synchronous call.
 *
 * The awkward part is that `runAsync` owns a callback's lifetime while an
 * adapter must hand a generator back to the caller. So the generator is driven
 * *inside* `runAsync` and its events are teed out through a promise-handoff
 * queue. Extracted from `client-wrapper.ts` (where it was written for the
 * client path) so the `query()` path in `query-wrapper.ts` reuses it rather
 * than growing a second, subtly different copy — MHQ-936.
 */
import { getActiveTraceState, runAsync as _runAsync } from "../_internal/tracing";

import type { SDKMessageLike } from "./types";

type QueueItem =
  | { kind: "value"; value: SDKMessageLike }
  | { kind: "error"; error: unknown }
  | { kind: "end" };

/**
 * Run `makeGenerator()` inside a trace and yield its events.
 *
 * Inside an existing trace this is a straight pass-through — the caller's
 * spans nest under their root. Outside one, a fresh trace named `agentName`
 * is opened and drains when iteration completes or throws.
 */
export function iterateInTrace(
  agentName: string | undefined,
  makeGenerator: () => AsyncGenerator<SDKMessageLike, void, unknown>,
): AsyncGenerator<SDKMessageLike, void, unknown> {
  if (getActiveTraceState() !== null) {
    return makeGenerator();
  }

  return (async function* outerTrace(): AsyncGenerator<SDKMessageLike, void, unknown> {
    const queue: QueueItem[] = [];
    let notify: (() => void) | null = null;
    const waitForItem = (): Promise<void> =>
      new Promise((resolve) => {
        if (queue.length > 0) {
          resolve();
        } else {
          notify = (): void => {
            notify = null;
            resolve();
          };
        }
      });

    const runPromise = _runAsync({ agentName }, async (runHandle) => {
      try {
        for await (const event of makeGenerator()) {
          queue.push({ kind: "value", value: event });
          notify?.();
        }
        runHandle.setOutcome(true);
      } catch (err) {
        queue.push({ kind: "error", error: err });
        notify?.();
        throw err;
      } finally {
        queue.push({ kind: "end" });
        notify?.();
      }
      return null;
    });
    // runAsync rethrows; the error is already queued for the consumer, so
    // swallow here purely to avoid an unhandled rejection.
    runPromise.catch(() => {
      /* already handled via queue */
    });

    while (true) {
      if (queue.length === 0) await waitForItem();
      const item = queue.shift();
      if (!item) continue;
      if (item.kind === "value") {
        yield item.value;
      } else if (item.kind === "error") {
        throw item.error;
      } else {
        return;
      }
    }
  })();
}
