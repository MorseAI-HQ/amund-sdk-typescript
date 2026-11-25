/**
 * Published-package variant of apps/sdk/typescript/dogfood/_common.ts.
 * Imports ONLY the public entrypoints of the npm-published @amundai/sdk —
 * no workspace source, no internal modules.
 */
import * as morse from "@amundai/sdk";

export const DEV_ENDPOINT_DEFAULT = "https://dev-api.morsehq.dev/api/v1/traces/batch";

/** `name` is unprefixed (`"API_KEY"`): reads `AMUND_<name>`, then the pre-rebrand `MORSE_<name>`. */
export function requireEnv(name: string): string {
  const v = process.env[`AMUND_${name}`]?.trim() || process.env[`MORSE_${name}`];
  if (!v) {
    console.error(`\nMissing env var: AMUND_${name} (or MORSE_${name})\n`);
    process.exit(2);
  }
  return v;
}

export async function runDogfood(
  serviceName: string,
  body: () => Promise<{ outcome?: string }>,
): Promise<void> {
  const apiKey = requireEnv("API_KEY");
  const endpoint =
    process.env.AMUND_ENDPOINT?.trim() || process.env.MORSE_ENDPOINT || DEV_ENDPOINT_DEFAULT;
  morse.init({ apiKey, endpoint, flushIntervalSeconds: 1 });
  console.log(`\n[pub-e2e] ${serviceName}  sdk=${morse.version}  endpoint=${endpoint}`);

  const start = Date.now();
  let exitCode = 0;
  try {
    const result = await body();
    const last = morse._getLastTraceForTesting() as {
      trace?: { trace_id?: string };
      spans?: Array<{ type?: string; name?: string; metadata?: Record<string, unknown> }>;
    } | null;
    const spans = last?.spans ?? [];
    console.log(
      `\n[pub-e2e OK ${serviceName}] traceId=${last?.trace?.trace_id ?? "<none>"} spans=${spans.length} outcome=${result.outcome ?? "ok"} elapsed=${Date.now() - start}ms`,
    );
    for (const s of spans) {
      const meta = s.metadata as Record<string, unknown> | undefined;
      console.log(
        `  • [${s.type}] ${s.name} model=${meta?.model ?? "—"} tokens_in=${meta?.input_tokens ?? "—"} tokens_out=${meta?.output_tokens ?? "—"} cost=${meta?.cost_usd ?? "—"}`,
      );
    }
    if (spans.length === 0) exitCode = 1;
  } catch (err) {
    exitCode = 1;
    console.error(`\n[pub-e2e FAIL ${serviceName}] ${String(err)}`);
  } finally {
    await morse.flush();
    await morse.shutdown();
  }
  process.exit(exitCode);
}
