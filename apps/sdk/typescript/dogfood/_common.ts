/**
 * Shared helpers for the Phase 13 dogfood scripts.
 *
 * - Reads MORSE_API_KEY + MORSE_ENDPOINT.
 * - Bails with a friendly message if a required env var is missing.
 * - Initializes the Morse SDK pointing at the dev env by default.
 * - Wraps the script body so we always print the trace id + span count
 *   before exiting, and so flush() always runs.
 */

import * as morse from "../src/index";

export const DEV_ENDPOINT_DEFAULT = "https://api.morsehq.dev/api/v1/traces/batch";

export function requireEnv(name: string, hint?: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    const help = hint ? `\n  ${hint}` : "";
    console.error(`\nMissing env var: ${name}${help}\n`);
    process.exit(2);
  }
  return v;
}

export function initDogfoodSdk(serviceName: string): void {
  const apiKey = requireEnv(
    "MORSE_API_KEY",
    "Use the dogfood org's dev key. See bizops/dogfood/README.md.",
  );
  const endpoint = process.env.MORSE_ENDPOINT || DEV_ENDPOINT_DEFAULT;

  morse.init({
    apiKey,
    endpoint,
    flushIntervalSeconds: 1,
  });

  // Help downstream filtering — every adapter we exercise gets a distinct
  // serviceName so dashboard panels group cleanly.
  console.log(`\n[dogfood] serviceName=${serviceName}  endpoint=${endpoint}`);
}

/**
 * Wrap the body of a dogfood script. Captures the trace id, prints a
 * summary, flushes, and exits with code 0/1 based on outcome.
 */
export async function runDogfood(
  serviceName: string,
  body: () => Promise<{ traceId?: string; spanCount?: number; outcome?: string }>,
): Promise<void> {
  initDogfoodSdk(serviceName);

  const start = Date.now();
  let exitCode = 0;
  try {
    const result = await body();
    const ms = Date.now() - start;
    console.log(
      `\n[dogfood ✅ ${serviceName}] traceId=${result.traceId ?? "<unknown>"}  spans=${
        result.spanCount ?? "?"
      }  outcome=${result.outcome ?? "ok"}  elapsed=${ms}ms`,
    );
    // Print the full span tree so we can compare real-SDK output against
    // what the mock fixtures predict.
    try {
      const tracingModule = await import("../src/_internal/tracing");
      const last = tracingModule.getLastTrace() as {
        spans?: Array<{
          type?: string;
          name?: string;
          parent_span_id?: string;
          span_id?: string;
          metadata?: Record<string, unknown>;
        }>;
      } | null;
      if (last?.spans?.length) {
        console.log(`\n  span tree (${last.spans.length} spans):`);
        const byId = new Map(last.spans.map((s) => [s.span_id ?? "?", s]));
        for (const s of last.spans) {
          const parent = s.parent_span_id ? byId.get(s.parent_span_id) : undefined;
          const depth = parent ? "    " : "  ";
          const adapter = (s.metadata as { adapter?: string } | undefined)?.adapter ?? "—";
          const kind =
            (s.metadata as { spawn_kind?: string; tool_kind?: string } | undefined)?.spawn_kind ??
            (s.metadata as { spawn_kind?: string; tool_kind?: string } | undefined)?.tool_kind ??
            "";
          console.log(
            `${depth}• [${s.type}${kind ? `:${kind}` : ""}] ${s.name}  adapter=${adapter}`,
          );
        }
      }
    } catch {
      /* swallow */
    }
  } catch (err) {
    exitCode = 1;
    const ms = Date.now() - start;
    console.error(`\n[dogfood ❌ ${serviceName}] elapsed=${ms}ms  error=${String(err)}`);
  } finally {
    try {
      await morse.flush();
      await morse.shutdown();
    } catch (flushErr) {
      console.error(`[dogfood] flush/shutdown error: ${String(flushErr)}`);
    }
  }
  process.exit(exitCode);
}
