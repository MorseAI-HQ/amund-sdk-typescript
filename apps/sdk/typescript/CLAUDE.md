# `apps/sdk/typescript/` — Claude / agent guidance

## Status

V2 SDK shipped in **Phase 6c** with module-level singleton API (`morse.init()`, `morse.track()`, `morse.batchTrack()`, `morse.run()` / `runTraced()`, `morse.span()`, `morse.flush()`, `morse.shutdown()`) plus a Vercel AI sub-export at `@morsehq/sdk/vercel-ai` and a low-level Anthropic Messages adapter at `@morsehq/sdk/anthropic`.

W3C Trace Context (`traceparent`) is exposed at the top level via `injectTraceparent` / `extractTraceparent` / `injectIntoRequestInit`. Server-side trace propagation uses `node:async_hooks.AsyncLocalStorage` when available, with a module-global fallback for the browser.

**Phase 13** (this commit, `openspec/changes/2026-05-26-phase-13-ts-agent-sdk-adapters/`) added three higher-level agent-SDK adapters:

- `@morsehq/sdk/anthropic-agent-sdk` — wraps a client-shaped object from `@anthropic-ai/claude-agent-sdk` (anything with a `.query` method). **NOT `ClaudeSDKClient`** — see the MHQ-936 note below
- `@morsehq/sdk/openai-agents` — wraps `Runner` from `@openai/agents`
- `@morsehq/sdk/langgraph` — `MorseCallbackHandler` for `@langchain/langgraph` (langgraphjs)

These share an internal `_agent-sdk-common/` module (span-emitter, redaction, context-propagation) that should NOT be re-exported. All three adapters use the same metadata schema — `subagent.spawn` modeled as `type=agent` + `metadata.spawn_kind="subagent"`, `hook` modeled as `type=tool` + `metadata.tool_kind="hook"` until the backend `SpanType` enum gains native variants. **Agent handoffs are no longer one of these stand-ins**: MHQ-1025 added a native `SpanType.HANDOFF`, so `@morsehq/sdk/openai-agents` emits a real `type=handoff` span (named `from → to`, metadata `{from_agent, to_agent}`) via `emitHandoffSpan` alongside the subagent span for the target. Both SDKs now agree on that shape — keep them in lockstep.

**MHQ-482** added `@morsehq/sdk/langchain` — `MorseCallbackHandler` for plain `@langchain/core` (chains/LLMs/tools/retrievers), a structural sibling of `@morsehq/sdk/langgraph` (not a subclass — see `src/langchain/callback-handler.ts`'s file header for why). It does NOT auto-create a trace when none is active (callers must wrap invocations in `morse.run()` / `runAsync()`) and does NOT compute `cost_usd` yet (no TS pricing module exists). It introduced a real `SpanType.RETRIEVER = "retriever"` value in `_internal/spans.ts` (Python already had this; the other two adapters' `hook`/`subagent` fallback-via-metadata pattern was not needed here).

**MHQ-758** (OSS dogfooding, `bizops/dogfood/ai-sdk-preview-rag.md`) found that `@morsehq/sdk/vercel-ai`'s original design — reassigning `ai`'s named exports in place (`aiModule.streamText = wrapped`) — silently failed against every real install of `ai`: it's pure ESM, and Node exposes its exports as non-configurable getter-only properties even through the CJS `require()` interop path, so the assignment threw and was swallowed by `absorbErrorsAsync`. Unlike `@anthropic-ai/sdk` (patches `Messages.prototype.create`, a plain mutable class property), `ai`'s functions have no prototype to patch. Fixed by replacing `instrumentVercelAI()`/`uninstallVercelAI()`/`isVercelAIInstalled()` (module-mutation) with `createTracedVercelAI()`, which resolves the real `ai` module once and returns traced _replacement_ functions the customer imports and calls instead — no mutation, so it can't hit a frozen-export wall. Consequence: `ai` moved from `FULL_INSTALL_TARGETS` to `DETECT_ONLY_TARGETS` in `_internal/auto-detect.ts` — there is nothing left to silently monkey-patch, so it can no longer be truly zero-config; auto-detect logs a one-time hint pointing at `createTracedVercelAI()` instead. Since SDK publishing is paused (no external consumers yet), this was a straight breaking-change swap, not a deprecate-and-add.

**MHQ-936 — the Claude Agent SDK adapter was rebuilt around `query()`.** The
contract check found `@anthropic-ai/claude-agent-sdk` exports no
`ClaudeSDKClient` at 0.1.77 _or_ 0.3.223 — that class is the _Python_ package's
API, and the TS adapter plus all its docs had been written from it. The
prototype-patching install path could therefore never bind, and the documented
`new ClaudeSDKClient(...)` threw for every user who copied it.

The supported entry point is now `wrapClaudeAgentQuery(query)`
(`src/anthropic-agent-sdk/query-wrapper.ts`), mirroring `createTracedVercelAI()`.
Two constraints drove that shape, both verified against the real package:

- `query` is exported **read-only and non-configurable**, so it cannot be
  patched in place — the identical wall `ai` hit in MHQ-758. Hence a returned
  replacement rather than zero-config auto-detect; `@anthropic-ai/claude-agent-sdk`
  is a `DETECT_ONLY_TARGETS` entry.
- `Query extends AsyncGenerator` **plus** control methods (`interrupt()`,
  `setPermissionMode()`, …). A plain `async function*` wrapper iterates fine and
  silently destroys all of them, so the traced return is a Proxy: iteration comes
  from the instrumented generator, everything else forwards to the real `Query`.
  Forwarding is the default rather than an allow-list, so control methods the SDK
  adds later keep working.

The package's surface moves between releases — 0.1.77 had
`unstable_v2_createSession`, 0.3.223 dropped it and added `startup`,
`forkSession`, `DirectConnectTransport`. `query` is the only thing stable across
both, which is why the contract check pins exactly that.

Deleted with this change: `findClientPrototypeCarrier`,
`loadClaudeAgentSDKModule`, the module-patch branch of `instrumentClaudeAgentSDK`,
and `uninstallClaudeAgentSDK` (which only undid a patch that could never apply).
`wrapClaudeAgentSDK` remains for any object exposing `.query`.

## Sibling SDKs

`apps/sdk/python/` is the Python SDK (already exists, Phase 6a-shipped, retrofitting to V2 in 6c). `apps/sdk/go/` and `apps/sdk/rust/` will land in Phase 7+.

## What you can safely change here

- The TypeScript SDK source (`src/`), tests (`tests/`), and configs.
- Public API shape — coordinate with `apps/sdk/python/` to keep the cross-language API consistent.

## What MUST NOT happen here

- No re-exports from `apps/sdk/python/` (wrong runtime).
- No coupling to `apps/api/` internals — the SDK is a published package; it can only depend on public ingestion-pipeline contracts.

## Wire-format contract — REQUIRED

Phase 13 shipped three silent wire-format drifts in one session (commits `35ea845`, `8e63930`, `e99d1c1`). Each was a one-line fix and each took ~30 min of live-DB grepping to find. The class of bug: an SDK-side wire-shape change the api silently rejects with HTTP 200 + per-trace error — undetectable by unit tests (mocked transport) and invisible to the SDK's caller (BatchTransport absorbs response errors).

**`dogfood/smoke.ts` exists to catch this in CI.** It constructs representative traces via the SDK's public surface (`run`, `spanAsync`, `track`) and checks them against the live dev backend. The workflow at `.github/workflows/sdk-ts-contract-dogfood.yml` runs it on every PR that touches `apps/sdk/typescript/**` or `apps/api/apps/traces/**`.

**Know which transport your scenario lands on, or you will write a check that cannot fail (MHQ-1033).** The smoke has four assertion regimes, not one:

| What                                         | Transport                 | Assertion                                                                    |
| -------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `run` / `runTraced` / `spanAsync` / `record` | OTLP (since MHQ-482)      | every `ExportResult` must be SUCCESS                                         |
| Span types (scenario 2e)                     | legacy JSON, deliberately | strict: HTTP 2xx, `accepted >= 1`, `rejected === 0`                          |
| Anthropic adapter (scenario 2f)              | legacy JSON, deliberately | strict: an `llm` span exists AND carries model/tokens/cost, then is accepted |
| `track()` / `batchTrack()` replay            | legacy JSON               | lenient — logged, never asserted (known MHQ-746 422 gap)                     |

Scenario 2f (MHQ-1052) is on the JSON path for a second reason on top of 2e's: it is the only path whose payload can be read here, and the defect it guards is a span that is _present and empty_, which every acceptance-only check passes. An adapter regression is invisible to the OTLP regime — the export succeeds either way.

`rejected === 0` was the file's headline assertion for months and is the weakest of them: the JSON path now carries only `track()`, so it routinely evaluates against an empty batch and reports `accepted=0` while proving nothing. Two span-type scenarios (`retriever`, `handoff`) were added under that misapprehension and asserted nothing at all — the OTLP endpoint returns 200 for a span type the server has never heard of, then stores it as `custom` (MHQ-1014). Scenario 2e exists because span-type validation only _rejects_ on the JSON path.

**Rule:** any new wire-level field or any change to `_internal/tracing.ts::buildTraceDict` or `_internal/spans.ts` field shape MUST be covered by a smoke scenario in `dogfood/smoke.ts` in the same PR — and the scenario must be one that would go red if the field were dropped. New `SpanType` values need no new scenario: 2e iterates `Object.values(SpanType)` and picks them up automatically, but it goes red until the backend enum is deployed to dev, so land the API side first. Storage fidelity (accepted vs. stored faithfully) is a separate claim, asserted in `apps/api/tests/traces/test_otlp_span_type_fidelity.py`. The mocked-transport unit tests are necessary but not sufficient.

Run locally:

```sh
MORSE_API_KEY=mhq_dev_... pnpm dogfood:smoke
```

See `openspec/changes/2026-05-27-sdk-wire-format-contract-tests/` for the rationale + escalation path to an ephemeral-Postgres contract suite if the dev-env smoke proves insufficient.
