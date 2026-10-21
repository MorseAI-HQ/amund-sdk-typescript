/**
 * Wire-format contract smoke test.
 *
 * Catches the class of bug that Phase 13 surfaced three times in one
 * session (commits 35ea845, 8e63930, e99d1c1): an SDK-side wire-shape
 * change that the api silently rejects with HTTP 200 + per-trace error
 * — undetectable by unit tests (which use a mocked transport) and
 * invisible to the SDK's caller (BatchTransport's `absorbErrorsAsync`).
 *
 * Strategy:
 *
 *   1. Initialize the SDK as a real customer would.
 *   2. Swap in a capture-only transport (the SDK's own `setTransport`).
 *   3. Construct a representative trace via the SDK's public surface
 *      (`run` + `spanAsync` + `record`) so every wire-payload code path
 *      gets exercised.
 *   4. POST the captured payload via raw `fetch` (bypassing
 *      BatchTransport's error absorption) and assert on the response.
 *
 * If any assertion fails, print the full response body to stderr and
 * exit non-zero so the GH Actions workflow turns the PR check red.
 *
 * WHAT IS ACTUALLY ASSERTED, and on which transport (MHQ-1033 — read this
 * before adding a scenario, or you will write one that cannot fail):
 *
 *   - OTLP path (`run`/`runTraced`/`spanAsync`/`record`, since MHQ-482):
 *     every `ExportResult` must be SUCCESS. This catches a payload the
 *     endpoint refuses. It does NOT catch a value the endpoint accepts and
 *     then silently reinterprets — an unrecognised `morse.span_type` falls
 *     through `_map_span_type` and is stored as `custom` (MHQ-1014).
 *   - Span types (scenario 2e): asserted deliberately on the legacy JSON
 *     path, the only one where the server validates `type` against its
 *     SpanType enum and REJECTS. Strict: exits non-zero.
 *   - `track()`/`batchTrack()` replay (the loop at the bottom): lenient by
 *     design — that path is a documented forward-compat escape hatch that
 *     422s (MHQ-746), so its failures are logged, never asserted. Its
 *     `accepted=0` is the normal steady state and means the JSON assertion
 *     had nothing to assert on. Do not read it as coverage of anything.
 *
 * Nothing here can see what was STORED — trace-detail endpoints are
 * session-authed (see the note at scenario 2b). Storage fidelity lives in
 * `apps/api/tests/traces/`.
 *
 * Env:
 *   MORSE_API_KEY    — a throwaway dev environment key (NEVER the dogfood
 *                      account's key)
 *   MORSE_ENDPOINT   — full `/api/v1/traces/batch` URL
 *
 * Both are wired in CI via the `CI_SDK_SMOKE_API_KEY` /
 * `CI_SDK_SMOKE_ENDPOINT` repo secrets (key = a throwaway environment key
 * on the dev e2e org's `ci-smoke` environment — never the dogfood
 * account's key; the secrets were named `CI_DOGFOOD_AGENTVISTA_*` until
 * 2026-07-27, which was actively misleading — see memory/decisions.md).
 *
 * Local usage:
 *   MORSE_API_KEY=mhq_... pnpm dogfood:smoke
 *
 * See `openspec/changes/2026-05-27-sdk-wire-format-contract-tests/`.
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";

import { setActiveFramework } from "../src/_internal/active-framework";
import { wrapAnthropic, type AnthropicClientLike } from "../src/anthropic/index";
import * as morse from "../src/index";
import {
  getMaxBatchSize,
  getMaxFieldBytes,
  getMaxQueueSize,
  getSampleRate,
} from "../src/_internal/env";
import { getEngine as getOtelEngine } from "../src/_internal/otel-provider";
import { SpanType } from "../src/_internal/spans";
import type { BatchTransport } from "../src/_internal/transport";

const DEV_ENDPOINT_DEFAULT = "https://dev-api.morsehq.dev/api/v1/traces/batch";

/** Mirrors `index.ts::deriveOtlpEndpoint` — not exported, so duplicated here. */
function deriveOtlpEndpoint(tracesEndpoint: string): string {
  try {
    const u = new URL(tracesEndpoint);
    u.pathname = "/api/v1/otlp/v1/traces";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return tracesEndpoint.replace(/\/api\/v1\/.*$/, "/api/v1/otlp/v1/traces");
  }
}

interface BatchResponse {
  accepted?: number;
  rejected?: number;
  errors?: Array<{ trace_id?: string; error?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Raw shape of a single event as it lands in `BatchTransport.track()` —
 * either a v2 trace envelope (`{ traces: [...] }`) or a bare v1 run/track
 * event (any other shape). `transport.ts::sendBatch` classifies each queued
 * event the same way before wrapping non-trace events as `{ runs: [...] }`
 * — replicated in `wrapForReplay` below since this capture shim intercepts
 * BEFORE that wrapping happens.
 */
type CapturedPayload = { traces: unknown[] } | Record<string, unknown>;

/** Mirrors `transport.ts::sendBatch`'s per-event classification + batch wrapping. */
function wrapForReplay(
  events: CapturedPayload[],
): Array<{ traces: unknown[] } | { runs: unknown[] }> {
  const traceEntries: unknown[] = [];
  const runEntries: unknown[] = [];
  for (const event of events) {
    if (typeof event === "object" && event !== null && "traces" in event) {
      const e = event as { traces: unknown[] };
      if (Array.isArray(e.traces)) traceEntries.push(...e.traces);
    } else {
      runEntries.push(event);
    }
  }
  const batches: Array<{ traces: unknown[] } | { runs: unknown[] }> = [];
  if (traceEntries.length > 0) batches.push({ traces: traceEntries });
  if (runEntries.length > 0) batches.push({ runs: runEntries });
  return batches;
}

/**
 * Assert the deployed backend accepts every `SpanType` the SDK can emit
 * (MHQ-1033). Strict by design — unlike the `track()`/`batchTrack()` replay at
 * the bottom of this file, a failure here is a real regression and exits
 * non-zero.
 */
async function assertSpanTypesAccepted(
  events: CapturedPayload[],
  endpoint: string,
  apiKey: string,
): Promise<void> {
  const knownTypes = Object.values(SpanType).join(", ");
  if (events.length === 0) {
    console.error(
      "[smoke] ❌ span-type matrix captured nothing — the MORSE_LEGACY_TRANSPORT toggle no longer\n" +
        "  routes run()/spanAsync() through the JSON transport, so this scenario is asserting on an\n" +
        "  empty batch. That is the exact failure mode MHQ-1033 fixed; do not 'fix' it by relaxing\n" +
        "  the assertion. See _internal/tracing.ts::sendTrace.",
    );
    process.exit(1);
  }
  for (const payload of wrapForReplay(events)) {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "morse-ts-sdk-smoke/1.0",
      },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let body: BatchResponse;
    try {
      body = JSON.parse(text) as BatchResponse;
    } catch {
      console.error(
        `[smoke] ❌ span-type matrix — non-JSON response (HTTP ${resp.status}):\n${text.slice(0, 800)}`,
      );
      process.exit(1);
    }
    if (resp.status === 401 || resp.status === 403) {
      console.error(
        `[smoke] ❌ CREDENTIAL PROBLEM, NOT A CODE PROBLEM — HTTP ${resp.status} from ${endpoint}\n` +
          `  See the identical note in the replay loop below for the fix.`,
      );
      process.exit(2);
    }
    const accepted = typeof body.accepted === "number" ? body.accepted : 0;
    const rejected = typeof body.rejected === "number" ? body.rejected : 0;
    if ((resp.status !== 200 && resp.status !== 202) || rejected > 0 || accepted < 1) {
      console.error(
        `[smoke] ❌ SPAN-TYPE CONTRACT BROKEN — HTTP ${resp.status}, accepted=${accepted}, rejected=${rejected}\n` +
          `  SDK emits: ${knownTypes}\n` +
          `  The deployed backend at ${endpoint} rejected at least one of them. Usual cause: a\n` +
          `  SpanType was added to the SDK and this branch has not been deployed to dev yet —\n` +
          `  the API-side enum must land first. Response: ${JSON.stringify(body)}`,
      );
      process.exit(1);
    }
  }
  console.log(`[smoke] span-type matrix OK — deployed backend accepts: ${knownTypes}`);
}

/**
 * Assert the Anthropic adapter's `llm` span exists, is populated, and is
 * accepted by the deployed backend (MHQ-1052). Strict — a failure here is a
 * regression of the published SDK's headline claim (cost + token visibility on
 * an instrumented LLM call), not a known gap.
 */
async function assertAnthropicLlmSpanAccepted(
  events: CapturedPayload[],
  endpoint: string,
  apiKey: string,
): Promise<void> {
  const spans: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null || !("traces" in event)) continue;
    for (const entry of (event as { traces: unknown[] }).traces) {
      const e = entry as { spans?: unknown };
      if (Array.isArray(e.spans)) spans.push(...(e.spans as Array<Record<string, unknown>>));
    }
  }
  const llm = spans.find((s) => s.type === "llm");
  if (!llm) {
    console.error(
      `[smoke] ❌ MHQ-1052 — wrapAnthropic() produced NO llm span (${spans.length} span(s): ` +
        `${spans.map((s) => `${String(s.type)}/${String(s.name)}`).join(", ") || "none"}).\n` +
        "  A customer instrumenting Anthropic gets an agent-level trace with zero LLM visibility\n" +
        "  and zero cost attribution, and nothing looks broken to them. Usual cause is not the\n" +
        "  adapter but the trace lifecycle around it — see MHQ-924.",
    );
    process.exit(1);
  }
  // Each of these is separately droppable and separately invisible to the
  // caller: the span can exist with no usage, or with usage and no cost.
  const missing = (["model", "input_tokens", "output_tokens", "cost_usd"] as const).filter((f) => {
    const v = llm[f];
    return v === undefined || v === null || (typeof v === "number" && !(v > 0));
  });
  if (missing.length > 0) {
    console.error(
      `[smoke] ❌ MHQ-1052 — wrapAnthropic()'s llm span is missing/zero on: ${missing.join(", ")}\n` +
        `  span: ${JSON.stringify(llm)}`,
    );
    process.exit(1);
  }

  for (const payload of wrapForReplay(events)) {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "morse-ts-sdk-smoke/1.0",
      },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let body: BatchResponse;
    try {
      body = JSON.parse(text) as BatchResponse;
    } catch {
      console.error(
        `[smoke] ❌ anthropic llm span — non-JSON response (HTTP ${resp.status}):\n${text.slice(0, 800)}`,
      );
      process.exit(1);
    }
    if (resp.status === 401 || resp.status === 403) {
      console.error(
        `[smoke] ❌ CREDENTIAL PROBLEM, NOT A CODE PROBLEM — HTTP ${resp.status} from ${endpoint}\n` +
          `  See the identical note in the replay loop below for the fix.`,
      );
      process.exit(2);
    }
    const accepted = typeof body.accepted === "number" ? body.accepted : 0;
    const rejected = typeof body.rejected === "number" ? body.rejected : 0;
    if ((resp.status !== 200 && resp.status !== 202) || rejected > 0 || accepted < 1) {
      console.error(
        `[smoke] ❌ anthropic llm span REJECTED by ${endpoint} (HTTP ${resp.status}, ` +
          `accepted=${accepted}, rejected=${rejected}): ${JSON.stringify(body.errors ?? body)}`,
      );
      process.exit(1);
    }
  }
  console.log(
    `[smoke] anthropic adapter OK — llm span accepted with model=${String(llm.model)} ` +
      `tokens=${String(llm.input_tokens)}/${String(llm.output_tokens)} cost_usd=${String(llm.cost_usd)}`,
  );
}

function requireEnv(name: string, hint?: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`\n[smoke] missing env var: ${name}${hint ? `\n  ${hint}` : ""}\n`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apiKey = requireEnv(
    "MORSE_API_KEY",
    "Use a throwaway dev environment key (CI: CI_SDK_SMOKE_API_KEY).",
  );
  const endpoint = process.env.MORSE_ENDPOINT || DEV_ENDPOINT_DEFAULT;
  console.log(`[smoke] endpoint=${endpoint}`);

  // Wire up the SDK as a real customer would, but inject a capture-only
  // shim as the transport BEFORE init() so `track()`/`record()`/
  // `batchTrack()` — which read `state.transport` captured once at
  // `buildSingleton()` time, not `_internal/tracing.ts`'s separately
  // swappable module-level `transport` var — actually route through it.
  // (`setTransport()` from `_internal/tracing.ts` only affects the legacy
  // `MORSE_LEGACY_TRANSPORT=1` trace-emission path, NOT `track()` — using
  // it here after `init()` silently captured nothing for scenario 3 below;
  // caught live against dev-api on 2026-07-28, see memory/decisions.md.)
  const captured: CapturedPayload[] = [];
  morse._setTransportFactoryForTesting(
    () =>
      ({
        track(event: unknown): boolean {
          captured.push(event as CapturedPayload);
          return true;
        },
        flush(): Promise<void> {
          return Promise.resolve();
        },
        shutdown(): Promise<void> {
          return Promise.resolve();
        },
      }) as unknown as BatchTransport,
  );
  morse.init({ apiKey, endpoint });

  // `run()`/`spanAsync()`/`runTraced()` no longer go through
  // `setTransport()` at all (MHQ-482) — they route through the real OTel
  // pipeline in `otel-provider.ts`. Reconfigure that engine with the same
  // options `morse.init()` just used, plus a `resultSink` tap, so this
  // smoke test can assert the live dev-api OTLP endpoint actually accepted
  // the protobuf payload instead of only checking the legacy JSON path
  // below. Mirrors `index.ts::buildSingleton`'s OTel-engine configure call.
  const otlpResults: ExportResult[] = [];
  getOtelEngine().configure({
    endpoint: deriveOtlpEndpoint(endpoint),
    apiKey,
    sampleRate: getSampleRate(),
    scheduleDelayMillis: 2000,
    maxQueueSize: getMaxQueueSize(),
    maxExportBatchSize: getMaxBatchSize(),
    maxFieldBytes: getMaxFieldBytes(),
    timeoutMillis: 10_000,
    redactionConfig: null,
    resultSink: (result) => otlpResults.push(result),
  });

  // Watch for spans the SDK silently dropped (MHQ-806 emits a warning when
  // span() runs with no active trace). A dropped span makes a scenario look
  // like it passed while covering nothing — which is exactly what happened
  // here: scenario 2 used the sync `run()` with an async callback, so its
  // tool and retriever spans never reached the backend, and the smoke stayed
  // green for months. Asserted after the flush below.
  const droppedSpanWarnings: string[] = [];
  const realConsoleWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    const text = args.map(String).join(" ");
    if (text.includes("no active trace")) droppedSpanWarnings.push(text);
    realConsoleWarn(...args);
  };

  // Exercise the public surface. Every scenario that creates a trace
  // should appear here so a regression in any code path is caught.

  // 1. Plain `run` + `record_outcome`. Goes over OTLP now — validated via
  //    `otlpResults` below, not `captured`.
  const r1 = morse.run("smoke-plain-run", (handle) => {
    handle.setOutcome(true, "smoke-ok");
    return "done";
  });
  if (r1 !== "done") {
    console.error("[smoke] run() did not return body value");
    process.exit(1);
  }

  // 2. `runTraced` with nested `spanAsync` covering all common span types.
  //    Also OTLP — validated via `otlpResults` below.
  //
  //    MUST be `runTraced`, not `run`. `run()` is the SYNC variant: handed an
  //    async callback it closes the trace the moment that callback returns its
  //    promise, so everything after the first `await` runs with no active
  //    trace and is silently dropped. This block used `run()` until 2026-08-01
  //    and the tool + retriever spans below were never actually reaching the
  //    backend — the retriever case in particular was added specifically to
  //    give a new SpanType wire coverage, and had none. Surfaced by the
  //    MHQ-806 diagnostic the moment it existed.
  await morse.runTraced({ agentName: "smoke-nested" }, async (handle) => {
    await morse.spanAsync({ name: "smoke-llm-call", type: "llm" }, async (span) => {
      if (span) {
        span.span.model = "smoke-fake-model";
        span.span.input_tokens = 10;
        span.span.output_tokens = 5;
        span.span.total_tokens = 15;
      }
      return null;
    });
    await morse.spanAsync({ name: "smoke-tool-call", type: "tool" }, async () => null);
    // Span-type coverage does NOT live here — see scenario 2e. Adding a
    // `type: "<new-type>"` line to this block proves nothing: everything in
    // here goes over OTLP, and the OTLP endpoint answers 200 for a type the
    // server has never heard of (it falls through `_map_span_type` and is
    // stored as `custom` — that IS MHQ-1014). The llm/tool spans above earn
    // their place by carrying model + token fields, not by their type.
    handle.setOutcome(true);
    return null;
  });

  // 2e. Span-type matrix (MHQ-1033). Every `SpanType` the SDK can emit,
  //     validated against the DEPLOYED backend's enum.
  //
  //     This has to run on the legacy JSON path, and that is the whole point:
  //     `apps/api/apps/traces/services.py` validates `span.type` against
  //     `_VALID_SPAN_TYPES` and raises AdapterValidationError — a REJECTION
  //     you can see — only on that path. The OTLP path never rejects an
  //     unknown type; it silently downgrades it. So a span-type scenario
  //     emitted the normal way (scenario 2) is unfalsifiable, which is how
  //     `smoke-retriever-call` and `smoke-handoff` sat here looking like
  //     coverage while asserting nothing.
  //
  //     Iterating `Object.values(SpanType)` rather than listing types keeps
  //     this self-maintaining: a new SDK SpanType is covered the moment it
  //     exists, and goes red until the backend that owns the enum is deployed
  //     with it. That red is correct — it is the deploy-order dependency, not
  //     a flake.
  //
  //     What this still cannot see is what was STORED (trace-detail endpoints
  //     are session-authed — see the note at 2b). Storage fidelity per type is
  //     asserted in apps/api/tests/traces/test_otlp_span_type_fidelity.py,
  //     parametrized over the same enum. A new SpanType needs BOTH.
  const spanTypeCaptureStart = captured.length;
  process.env.MORSE_LEGACY_TRANSPORT = "1";
  try {
    await morse.runTraced({ agentName: "smoke-span-types" }, async (handle) => {
      for (const spanType of Object.values(SpanType)) {
        await morse.spanAsync(
          { name: `smoke-span-type-${spanType}`, type: spanType },
          async () => null,
        );
      }
      handle.setOutcome(true);
      return null;
    });
  } finally {
    delete process.env.MORSE_LEGACY_TRANSPORT;
  }
  // Take these entries out of `captured` so the lenient track()/batchTrack()
  // replay at the bottom doesn't post them a second time — and, more to the
  // point, doesn't downgrade a real rejection here into a logged "known
  // MHQ-746 gap".
  const spanTypeEvents = captured.splice(spanTypeCaptureStart);
  await assertSpanTypesAccepted(spanTypeEvents, endpoint, apiKey);

  // 2f. Anthropic adapter llm span (MHQ-1052). Live OSS testing of 0.5.0-rc.1
  //     found `wrapAnthropic()` landing an agent span and NO llm span — no
  //     tokens, no cost — while Python emitted both. The cause was MHQ-924
  //     (the sync `run()` closed the trace before an async body pushed its
  //     child spans), so the adapter itself was never edited and nothing here
  //     would have noticed the regression or its return.
  //
  //     Two things have to hold, and they fail differently:
  //       - the SPAN exists and carries model/tokens/cost — asserted against
  //         the payload below, because an adapter that stops populating them
  //         still produces a perfectly acceptable trace;
  //       - the backend ACCEPTS it — asserted by POSTing that same payload.
  //
  //     On the JSON path for the same reason scenario 2e is: it is the only
  //     path that gives a per-trace rejection to assert on, and the only one
  //     whose payload can be read here. The client is a stub — `wrapAnthropic`
  //     types structurally, so this needs no ANTHROPIC_API_KEY and no network
  //     call to Anthropic.
  //
  //     Deliberately NOT wrapped in `run()`/`runTraced()`: bare
  //     `wrapAnthropic(client).messages.create(...)` is the documented entry
  //     point and the shape the bug was reported against — the adapter opens
  //     its own trace when none is active.
  const anthropicCaptureStart = captured.length;
  process.env.MORSE_LEGACY_TRANSPORT = "1";
  try {
    const wrapped = wrapAnthropic({
      messages: {
        create: async () => ({
          id: "msg_smoke",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 11, output_tokens: 7 },
          content: [{ type: "text", text: "smoke" }],
        }),
      },
    } as unknown as AnthropicClientLike);
    await wrapped.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      system: "you are a smoke test",
      messages: [{ role: "user", content: "hello" }],
    });
  } finally {
    delete process.env.MORSE_LEGACY_TRANSPORT;
  }
  await assertAnthropicLlmSpanAccepted(captured.splice(anthropicCaptureStart), endpoint, apiKey);

  // 2g. Attribution fields (MHQ-1275, ATTR-01/04): record keys, agent version and
  //     prompt references. Rides OTLP, so the engine's `ExportResult`s below prove
  //     the endpoint accepts the new `morse.record_key.*` / `morse.agent_version` /
  //     `morse.prompt.*` attributes. What THIS block adds is the half OTLP cannot
  //     show: the endpoint returns 200 whether or not the SDK sent the fields, so the
  //     built trace dict is read back and every field must be on it. Storage fidelity
  //     is asserted server-side (apps/api/tests/traces/test_attribution_*.py).
  await morse.runTraced(
    {
      agentName: "smoke-attribution",
      recordKeys: { smoke_run: "attr-1" },
      agentVersion: "smoke-1",
    },
    async () => {
      morse.linkRecord("smoke_ticket", 4812);
      await morse.spanAsync({ name: "smoke-prompted", type: "llm" }, async () => {
        morse.setPrompt("smoke-prompt", 3);
        return null;
      });
      return null;
    },
  );
  const attribution = morse._getLastTraceForTesting() as unknown as {
    trace: {
      record_keys?: Record<string, string>;
      agent_version?: string;
      prompts?: Array<{ name: string; version?: number; span_id?: string }>;
    };
  } | null;
  const attributionProblems: string[] = [];
  if (attribution?.trace.record_keys?.smoke_run !== "attr-1")
    attributionProblems.push("record_keys.smoke_run");
  if (attribution?.trace.record_keys?.smoke_ticket !== "4812")
    attributionProblems.push("record_keys.smoke_ticket (linkRecord)");
  if (attribution?.trace.agent_version !== "smoke-1") attributionProblems.push("agent_version");
  const smokePrompt = attribution?.trace.prompts?.find((p) => p.name === "smoke-prompt");
  if (smokePrompt?.version !== 3 || !smokePrompt.span_id)
    attributionProblems.push("prompts[smoke-prompt] version/span_id");
  if (attributionProblems.length > 0) {
    console.error(
      `[smoke] FAIL — attribution fields missing from the built trace: ${attributionProblems.join(", ")}`,
    );
    process.exit(1);
  }

  // 2b. Payload-shape matrix (MHQ-812). A span payload is an arbitrary JSON
  //     value, not necessarily an object — `set_output(data: Any)` accepts
  //     anything and storage is a JSONField. MHQ-805 shipped because nothing
  //     exercised the non-dict shapes end to end.
  //
  //     This asserts the INGEST half from the TypeScript side. The read-back
  //     half (does the API serve these payloads back unchanged?) is covered in
  //     apps/api/tests/traces/test_sdk_read_back_contract.py, which runs the
  //     same matrix in-process through the Django test client — trace-detail
  //     endpoints are session-authenticated and API keys are ingest-scoped, so
  //     it cannot be asserted from here without storing a login in CI.
  //
  //     The falsy entries carry the most weight: 0, false and "" are the shapes
  //     a `!value` guard silently swallows.
  const PAYLOAD_SHAPES: unknown[] = [
    { messages: [{ role: "user", content: "hi" }] },
    "a bare string",
    42,
    3.5,
    true,
    ["a", "b", "c"],
    { nested: { deep: [1, 2, { k: "v" }] } },
    0,
    false,
    "",
  ];

  await morse.runTraced({ name: "smoke-payload-shapes" }, async (handle) => {
    for (let i = 0; i < PAYLOAD_SHAPES.length; i++) {
      await morse.spanAsync({ name: `smoke-payload-${i}`, type: "custom" }, async (span) => {
        if (span) {
          span.span.input_data = PAYLOAD_SHAPES[i];
          span.span.output_data = PAYLOAD_SHAPES[i];
        }
        return null;
      });
    }
    handle.setOutcome(true);
    return null;
  });

  // 2c. Framework discovery (MHQ-859). `morse_ai.framework` on the trace
  //     resource is a NEW wire-level field — per this package's wire-format
  //     contract rule it needs smoke coverage, since the api's schema is the
  //     actual source of truth and a mocked-transport unit test cannot tell
  //     an accepted field from a silently-rejected one. Set directly here
  //     rather than through an adapter so the scenario needs no provider key.
  await morse.runTraced({ agentName: "smoke-framework" }, async (handle) => {
    setActiveFramework("langgraph");
    await morse.spanAsync({ name: "smoke-framework-llm", type: "llm" }, async (span) => {
      if (span) {
        span.span.model = "smoke-fake-model";
        span.span.input_data = { messages: [{ role: "user", content: "hi" }] };
        span.span.output_data = { content: "hello" };
      }
      return null;
    });
    handle.setOutcome(true);
    return null;
  });

  // 2d. Multi-turn attribution (MHQ-1029). `thread_id` has been in the wire
  //     schema since MHQ-748 but nothing ever put a value on it: no adapter
  //     populated it, so it crossed the wire only when app code passed
  //     `run({ threadId })` — which the smoke never did either. The adapters
  //     now fill it from framework conversation identity, so the field goes
  //     from theoretical to always-present, and it needs the same coverage
  //     any new wire field gets. Two turns, one thread — the shape the
  //     dashboard groups on.
  for (const turn of [1, 2]) {
    await morse.runTraced(
      { agentName: "smoke-multi-turn", threadId: "smoke-thread-1", userId: "smoke-user-1" },
      async (handle) => {
        await morse.spanAsync({ name: `smoke-turn-${turn}`, type: "llm" }, async (span) => {
          if (span) span.span.model = "smoke-fake-model";
          return null;
        });
        handle.setOutcome(true);
        return null;
      },
    );
  }

  // 3. Top-level `track` envelope — tests the non-trace event path, still
  //    on the legacy JSON `setTransport()` path.
  morse.track({
    agentId: "smoke-track-direct",
    runData: { success: true, outcome: "tracked" },
  });

  // 3b. `record()` — migrated off the legacy `runs` path to the same
  // `traces`-shaped OTLP emission `run()`/`span()` use (MHQ-746). Also
  // validated via `otlpResults` below, not `captured`.
  morse.record({
    agent: "smoke-record-agent",
    success: true,
    outcome: "smoke-recorded",
    cost: 0.01,
    model: "smoke-fake-model",
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
  });

  // 4. Flush so any timer-based emission goes through both the OTLP engine
  //    and the legacy capture shim.
  await morse.flush();

  console.warn = realConsoleWarn;
  if (droppedSpanWarnings.length > 0) {
    console.error(
      `\n[smoke] ❌ ${droppedSpanWarnings.length} span(s) were silently dropped — a scenario ` +
        `above ran outside an active trace and covered nothing:\n` +
        droppedSpanWarnings.map((w) => `  - ${w}`).join("\n") +
        `\n\nUsual cause: an async callback passed to the SYNC \`run()\`. Use \`runTraced()\` ` +
        `for async work — \`run()\` closes the trace as soon as the callback returns its promise.\n`,
    );
    process.exit(1);
  }

  // Assert the OTLP path: every export the engine attempted must have
  // succeeded against the live dev-api endpoint (protobuf+gzip POST to
  // `<endpoint>/api/v1/otlp/v1/traces`). A SpanExporter's `ExportResult`
  // is the only place a schema/wire drift on this path would surface —
  // unlike the JSON path, there's no accepted/rejected counter to check
  // after the fact, so this must run before any process exit.
  if (otlpResults.length === 0) {
    console.error(
      "[smoke] FAIL — no OTLP export results captured. run()/spanAsync() are not reaching the OTel engine (check MORSE_LEGACY_TRANSPORT is unset).",
    );
    process.exit(1);
  }
  const otlpFailures = otlpResults.filter((r) => r.code !== ExportResultCode.SUCCESS);
  if (otlpFailures.length > 0) {
    console.error(
      `[smoke] FAIL — OTLP WIRE-FORMAT CONTRACT BROKEN — ${otlpFailures.length}/${otlpResults.length} export(s) failed against ${deriveOtlpEndpoint(endpoint)}:\n` +
        otlpFailures.map((r) => `  ${String(r.error ?? "unknown error")}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(`[smoke] OTLP path OK — ${otlpResults.length} export(s) accepted`);

  // Everything reaching `captured` from here on is `track()`/`batchTrack()`
  // only — `record()` was migrated off this path in MHQ-746, same as
  // `run()`/`span()` were in the OTLP port above. `track()`/`batchTrack()`
  // are NOT part of the SDK's supported wire contract: they're a
  // documented forward-compat escape hatch (mirrors Python's identical
  // `client.py::track()`/`batch_track()`, whose own `transport.py`
  // docstring admits "the backend has no /runs ingest route; this path
  // will 422"). So failures below are logged as a known, tracked
  // (MHQ-746) limitation, NOT asserted — they must not fail the build for
  // a gap that isn't a regression. If `record()`/`run()`/`span()` ever
  // start reaching this block too, THAT would be a real regression; watch
  // for `captured` growing beyond what `track()`/`batchTrack()` alone
  // would produce.
  if (captured.length === 0) {
    console.log(
      "[smoke] note — no track()/batchTrack() payloads captured (none exercised, or SDK init failed).",
    );
    // Deliberately does NOT print an accepted/rejected tally. It used to, as
    // "✅ wire-format contract OK — accepted=0 rejected=0", which reads like a
    // green contract check and is nothing of the sort: zero accepted means the
    // JSON assertion had no payload to assert on (MHQ-1033). The contract that
    // actually held is the OTLP + span-type output above.
    console.log(`\n[smoke] ✅ OTLP + span-type contracts OK (JSON path exercised nothing)\n`);
    return;
  }
  console.log(`[smoke] captured ${captured.length} raw event(s) (track()/batchTrack() only)`);

  // Replay the captured events against the real api via raw fetch, wrapped
  // into batches the same way `transport.ts::sendBatch` would — this shim
  // intercepts BEFORE that wrapping happens, so it must be replicated here
  // or a bare non-trace event 422s against the batch endpoint's schema
  // (caught live against dev-api on 2026-07-28: the endpoint requires
  // either a `traces` or `runs` key, never a bare event object).
  const batches = wrapForReplay(captured);
  let totalAccepted = 0;
  let totalRejected = 0;

  for (let i = 0; i < batches.length; i++) {
    const payload = batches[i]!;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "morse-ts-sdk-smoke/1.0",
      },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let body: BatchResponse;
    try {
      body = JSON.parse(text) as BatchResponse;
    } catch {
      console.log(
        `[smoke] note — payload[${i}] (track()/batchTrack(), known MHQ-746 gap) non-JSON response (HTTP ${resp.status}):\n${text.slice(0, 800)}`,
      );
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      console.error(
        `[smoke] ❌ CREDENTIAL PROBLEM, NOT A CODE PROBLEM — HTTP ${resp.status} from ${endpoint}\n` +
          `  The stored CI_SDK_SMOKE_API_KEY repo secret is invalid or was rotated/revoked.\n` +
          `  Fix: mint a fresh throwaway environment key on dev (e2e org → ci-smoke environment →\n` +
          `  rotate-key) and run: gh secret set CI_SDK_SMOKE_API_KEY\n` +
          `  Response: ${JSON.stringify(body)}`,
      );
      process.exit(2);
    }

    // 202 = api has INGEST_ASYNC_ENABLED: schema validation still runs
    // synchronously (a wire-shape drift 422s before the handler), but
    // per-trace persist errors are deferred — `accepted` means "queued".
    if (resp.status !== 200 && resp.status !== 202) {
      console.log(
        `[smoke] note — payload[${i}] (track()/batchTrack(), known MHQ-746 gap) HTTP ${resp.status}: ${JSON.stringify(body)}`,
      );
      continue;
    }

    const accepted = typeof body.accepted === "number" ? body.accepted : 0;
    const rejected = typeof body.rejected === "number" ? body.rejected : 0;
    totalAccepted += accepted;
    totalRejected += rejected;

    if (rejected > 0) {
      console.log(
        `[smoke] note — payload[${i}] (track()/batchTrack(), known MHQ-746 gap) rejected=${rejected}: ${JSON.stringify(body.errors ?? [])}`,
      );
    } else {
      console.log(`[smoke] payload[${i}] OK — accepted=${accepted}, rejected=0`);
    }
  }

  // The tally below covers the track()/batchTrack() replay ONLY — that is all
  // that reaches this path. It is not a statement about run()/span()/record()
  // (OTLP, asserted above) or about span types (scenario 2e, asserted above).
  // accepted=0 here is normal and proves nothing either way (MHQ-1033).
  console.log(
    `\n[smoke] ✅ wire-format contracts OK — track()/batchTrack() replay: accepted=${totalAccepted}  ` +
      `rejected=${totalRejected} (failures logged above, if any, are a known MHQ-746 gap, not a regression)\n`,
  );
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
