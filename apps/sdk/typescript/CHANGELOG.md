# Changelog

All notable changes to `@morsehq-dev/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The TypeScript and Python SDKs version **independently** — they share `0.4.0` as
their first public release because they reached feature parity there, not
because they are released in lockstep. Expect the numbers to diverge.

## [Unreleased]

### Added

- **Retriever `documents[]` (@beta).** LangChain retriever spans now report each
  returned chunk as `{ rank, id, content, score, source }` (content truncated to
  2KB with `truncated: true`, max 10 chunks) so Morse can sample and judge
  retrieval quality. Additive: `docs_count`, `top_score`, `sources` and
  `content_preview` are unchanged.
- Failed spans now send the thrown error's class name as `exception_type`, and the OTel
  exporter emits a `recordException`-shaped `exception` event (`exception.type`,
  `exception.message`) so repeated failures can be grouped by type and message.
  Additive; no behaviour change when nothing throws.

### Fixed

- Traces now carry the resolved agent name as root-span attribute `morse.agent`
  (explicit name, then framework-native name, then `OTEL_SERVICE_NAME`, then
  entry-script name, then `default-agent`). The SDK resource no longer carries
  `service.name`; a process `OTEL_SERVICE_NAME` is kept as
  `morse.process.service_name` (MHQ-1100).

## [0.7.0] — Unreleased

### Changed — behaviour change, no API change

- **Database capture is now ON by default** (`pg`, `mysql2`, `better-sqlite3`), and records only
  inside an open trace. Before 0.7.0 it needed `MORSE_CAPTURE_DB=1`.
  **To opt out and keep the old behaviour, set `MORSE_CAPTURE_INFRA=0`** (or `MORSE_CAPTURE_DB=0`;
  a specific flag wins). Expect a higher span count per trace.
- **Database spans no longer appear outside a trace.** The `pg` / `mysql2` / `better-sqlite3`
  instrumentations previously started a stand-alone root span for a query made with no trace open.
  They now sit behind a gate that records only inside a Morse trace.
- **Literal values written inline in SQL are replaced with `?`** (strings, numbers, hex,
  dollar-quoted bodies, comments); bound-parameter attributes are dropped.
- **A failed db / http / queue span records the error class, not the message.**
- **Per-trace caps:** at most 200 `db`, 100 `http` and 100 queue publish spans per trace; the rest
  fold into one summary span per kind (`infra.suppressed_count`).

### Added

- **HTTP capture** for `fetch` (undici) and `node:http` / `node:https`, matching Python: an `http`
  span named `METHOD host` with the response status. Path, query string, headers and bodies are
  never read. LLM provider hosts, the Morse ingest host and `MORSE_CAPTURE_HTTP_EXCLUDE_HOSTS` are
  excluded. On by default; `MORSE_CAPTURE_HTTP=0` disables. Uses `diagnostics_channel`, so it
  works in ESM and CJS and adds no dependency.
- **Queue spans.** BullMQ `Queue.add` / `addBulk` and SQS (`@aws-sdk/client-sqs`) `SendMessage*`
  inside a trace record a `custom` span `publish <destination>` with OpenTelemetry messaging
  attributes and inject a W3C `traceparent` (BullMQ `telemetry.metadata`, SQS message attribute).
  On by default; `MORSE_CAPTURE_QUEUE=0` disables. Like the DB instrumentations, these patch at
  `require()` time.
- **Consumer-side trace continuation, opt-in** (`MORSE_CAPTURE_QUEUE_CONSUMER=1`) through
  `continueFromBullMqJob(job, name, fn)` and `continueFromSqsMessage(msg, name, fn)`.
- `benchmarks/infra-capture-overhead.ts` (`pnpm bench:infra`).

### Fixed

- **`run({ incomingTraceparent })` threw in the ESM build** (a lazy `require()` of a sibling
  module, which does not exist in ESM). The trace now continues as documented.

## [0.6.0] — 2026-10-01

### Changed — BREAKING

- **Wire attributes moved from `av.*` to `morse.*`** (#1002). Every OTLP
  attribute the SDK emits now uses the `morse.*` namespace. A collector or
  dashboard keyed on `av.*` attributes must be updated.
- **A clean exit no longer claims success** (MHQ-1157). `run()` used to
  send `success=true` when your code returned without error. The server stores
  any `success` as a developer-declared outcome — the top provenance tier,
  which no later eval, classifier or webhook signal could ever overwrite. Now
  only a declared outcome is sent; a raise/throw still records `success=false`.
  Declare outcomes with `morse.setOutcome(success, outcome?)`.

### Added

- **`morse.setOutcome(success, outcome?)`** — declares the outcome of whichever
  trace is open, without needing the run handle.

### Fixed

- **`sdk_version` is now recorded on OTLP traces.** The instrumentation scope
  carried no version, so every trace was stored as `otlp/http`.
- **`/openai-agents` triple-counted tokens** (MHQ-1155). `usage` was copied
  onto every span; newer `@openai/agents` puts run totals on `task`/`turn`
  spans. Tokens now sit on llm spans only.
- **`/anthropic-agent-sdk` recorded each LLM call twice** — one span per
  content-block `assistant` event, doubling tokens and cost. Now one span per
  call (one per turn in multi-turn runs).
- **LLM input/output captured** for `/openai-agents`, `/vercel-ai`,
  `/anthropic-agent-sdk`, and `/langchain` chat-model input (MHQ-1156), through
  the existing redaction path.

## [0.5.0] — 2026-08-08

### Changed — BREAKING

- **Sentry is gone from the SDK, replaced by Morse-owned self-diagnostics**
  (MHQ-908). When the SDK absorbs one of its own internal errors it now reports
  to Morse's `/api/v1/diagnostics/sdk` instead of to a third party you may not
  have installed.

  The old reporter **hijacked your global Sentry client** (MHQ-729) — if you
  used Sentry, the SDK could reconfigure it underneath you. That is the defect
  this removes. If you were relying on Morse SDK errors reaching your Sentry,
  they no longer will; they go to your own console instead.

  **This is on by default, at level `error`.** Upgrading turns transmission on.
  Two channels, both silent on a healthy install: absorbed **errors** carrying
  a Morse-scoped stack (our frames only — yours collapse to a count, and no
  local variables are ever read), and aggregate **delivery counters** telling
  you when telemetry is being dropped.

  Everything transmitted is also written to your own console first,
  rate-limited, **even when you have opted out** — there is no category of
  self-reported information we receive that your engineers cannot see. Opt out
  with `MORSE_SDK_DISABLE_TELEMETRY=1`. Full field-by-field disclosure:
  https://docs.morsehq.dev/sdk/self-diagnostics

### Added

- **`wrapClaudeAgentQuery(query)`** — the supported entry point for
  `@anthropic-ai/claude-agent-sdk` (MHQ-936). Wrap the package's top-level
  `query` and call the returned function in its place:

  ```ts
  import { query } from "@anthropic-ai/claude-agent-sdk";
  import { wrapClaudeAgentQuery } from "@morsehq-dev/sdk/anthropic-agent-sdk";

  const tracedQuery = wrapClaudeAgentQuery(query);
  for await (const message of tracedQuery({ prompt: "..." })) {
    /* ... */
  }
  ```

  The result is still a `Query` — `interrupt()`, `setPermissionMode()` and any
  other control method are forwarded to the real one.

### Removed — BREAKING

- **`uninstallClaudeAgentSDK`**, and the module-patching mode of
  `instrumentClaudeAgentSDK`. Both existed to install and remove a patch on
  `ClaudeSDKClient.prototype.query` — a class the TypeScript package has never
  exported (it is the Python package's API), so the install always silently
  no-opped and the uninstall had nothing to undo. Patching the real `query`
  export is impossible regardless: it is read-only and non-configurable.

  Migration: use `wrapClaudeAgentQuery(query)` above. `wrapClaudeAgentSDK` and
  the single-argument `instrumentClaudeAgentSDK(client)` still work for any
  object exposing a `.query` method.

  If you followed the previous `new ClaudeSDKClient(...)` example from our docs,
  it never ran — it threw `TypeError: ClaudeSDKClient is not a constructor`.
  That example has been corrected everywhere it appeared.

### Changed — BREAKING

- **Declared peer-dependency floors raised to versions we actually verify.**
  Previously the declared ranges were far wider than anything ever executed
  (`ai >=3.0.0` while only v7 had ever run; `@openai/agents >=0.0.1` resolving
  to literally `0.0.1`). Versions below the new floors are no longer supported.

  | Peer                             | Was        | Now        |
  | -------------------------------- | ---------- | ---------- |
  | `ai`                             | `>=3.0.0`  | `>=7.0.0`  |
  | `openai`                         | `>=4.0.0`  | `>=6.0.0`  |
  | `@anthropic-ai/sdk`              | `>=0.30.0` | `>=0.90.0` |
  | `@anthropic-ai/claude-agent-sdk` | `>=0.1.0`  | `>=0.3.0`  |
  | `@langchain/core`                | `>=0.3.0`  | `>=1.0.0`  |
  | `@langchain/langgraph`           | `>=0.2.0`  | `>=1.0.0`  |
  | `@openai/agents`                 | `>=0.0.1`  | `>=0.2.0`  |

  `@openai/agents` is held at the `0.2.x` line deliberately: 0.5.0 and later
  require peer `zod ^4` and this monorepo is on zod 3.

  If you are below a floor, pin the previous SDK release until you can upgrade.
  See `engineering/SDK_VERSION_SUPPORT.md` for the policy behind these numbers.

### Fixed

- **A metadata value that throws no longer takes your process down**
  (MHQ-947). `setContext()`, `run({ userMetadata })` and span `metadata` are
  YOUR values, and the SDK is the one that reads and stringifies them — so an
  object whose `toString` or property getter throws ran that code on the
  telemetry path and the exception escaped into your application. The span
  case terminated the process outright. A realistic trigger is an ORM object
  whose `toString` lazily hits a dead connection.

  Coercion is now guarded per key and per span field: a value that throws is
  dropped and reported to us, and **every other dimension still arrives**.
  Losing one metadata key beats losing the span, and losing the span beats
  crashing your app.

- **Self-diagnostics could not say where the SDK broke, in every published
  build.** `MORSE_PATH_MARKERS` listed only the in-repo package name
  (`@morsehq/sdk`), but the release pipeline rewrites the package to
  `@morsehq-dev/sdk` before publishing — so no frame in any customer install
  was ever recognised as ours. Every diagnostic stack collapsed to
  `[{elided: n}]`: the feature transmitted, but its most useful field was
  empty. Found against the published `0.5.0-rc.4` artifact, which is the only
  place it is visible — the in-repo name matches in dev and in every test.
  The host-frame elision is unchanged, so the fail-closed guarantee still
  holds.

- **The package can be bundled for the browser again.** `index.ts` reached
  `_internal/otel-provider.ts`, `db-capture.ts` and `auto-detect.ts` through a
  static import chain, and those modules statically import Node-only packages
  (`@opentelemetry/sdk-trace-node`, `@opentelemetry/context-async-hooks` →
  `async_hooks`, `@opentelemetry/instrumentation*` and `node:module`). Any
  bundler compiling for the browser therefore had to resolve Node built-ins
  and failed — which broke full-stack frameworks that compile the same import
  for both server and client. A `"browser"` export condition now points such
  bundlers at a browser-safe build (`dist/browser/`) in which those three
  modules are replaced by browser stubs. No consumer configuration required.

### Added

- **Agent-SDK contract checks** (`pnpm contract`). Every adapter now has an
  assertion that loads the real package and verifies the export it patches, the
  class it subclasses, or the function it replaces still exists — run on every
  PR, plus nightly against each framework's newest published release. Before
  this, the unit suite passed with every instrumented agent SDK _uninstalled_,
  so a dependency bump proved nothing.
- Browser build behaviour: traces are sent over the JSON transport (the OTLP
  span pipeline is Node-only), and the SDK logs a single `console.info` on
  `init()` naming exactly what is and isn't active rather than degrading
  silently. DB capture and adapter auto-detect are inert in browsers — both
  hook Node's `require`, which does not exist there.

## [0.4.0] — 2026-07-31

First public release on npm. Published as `@morsehq-dev/sdk`; `@morsehq/sdk` is
only the internal pnpm workspace identifier.

### Added

- **Parity with the Python SDK** (MHQ-482, MHQ-744/746-751/758) across eight
  public entry points: the root package plus `/anthropic`,
  `/anthropic-agent-sdk`, `/openai`, `/openai-agents`, `/langchain`,
  `/langgraph`, `/vercel-ai`, and `/integrations/pino`.
- pino log forwarding via `morsePinoDestination`.
- OTLP export with W3C trace-context propagation, matching the Python SDK's
  wire behavior.

### Fixed

- **Subpath adapters silently sent no spans.** Each entry point was bundled
  fully self-contained, so every adapter had its own copy of the module-scope
  singletons in `_internal/tracing.ts` — `morse.init()` called through the root
  entry initialized state that `/vercel-ai`, `/anthropic`, `/langgraph` and the
  rest never read. Enabling esbuild code splitting restores one shared instance
  across the package (MHQ-758).
- API keys are redacted under both the current `mhq_` prefix and the legacy
  `av_` prefix.

### Changed

- **The SDK version is now declared in exactly one place** (`package.json`) and
  injected into the bundle at build time. It was previously duplicated as a
  hand-maintained constant in `_internal/transport.ts`, which could drift from
  the released version and then misreport `sdk_version` on every span and in the
  `User-Agent` header. Builds run straight from source (vitest, ts-node) report
  `0.0.0-dev`, since a source checkout has no release version.
