# Changelog

All notable changes to `@morsehq-dev/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The TypeScript and Python SDKs version **independently** — they share `0.4.0` as
their first public release because they reached feature parity there, not
because they are released in lockstep. Expect the numbers to diverge.

## [Unreleased — next minor] Agent identity v2 (MHQ-1408)

Behaviour change, default on. `MORSE_AGENT_IDENTITY=legacy` restores the old naming and span shapes.

### Changed

- **Identity ladder.** Agent name resolves `run()` name > framework-native root (graph / starting
  agent) > `service.name` > entry script. The trace carries `identity_source`
  (`run|framework|service_name|entry_script|default`). Launcher scripts such as Next.js
  `start-server` no longer name an agent.
- **Framework nodes are spans, not agents.** LangGraph/LangChain chains, openai-agents `task`/`turn`
  envelopes (formerly tools `task.Agent workflow` / `turn.anon`) and the starting agent's duplicate
  spans are recorded as `custom` spans with `metadata.span_kind="chain"`. Handoff targets are no
  longer recorded twice.
- **Parents follow callback parentage**, so parallel branches keep their own LLM/tool spans.
- **`run("name")` is a label** when an adapter discovers a root: the trace's agent is the discovered
  root and the name is sent as `morse.app` (trace metadata `morse_app`).

### Fixed

- `run({ name })` is accepted as an alias of `run({ agentName })` instead of being silently ignored (MHQ-1415).

## [0.7.0] — Unreleased

### Added

- **`wrapOpenAI` traces `responses.create`.** The OpenAI Responses API now emits an
  `openai.responses.create` `llm` span alongside the existing `chat.completions.create` span, with
  model, input/output/cached/reasoning tokens, cost, and prompt/response capture (`instructions`
  as a system message, `input` as a string or message items, `function_call` output as
  `[tool_call:name] args`). A client without `responses` is unaffected. Streaming
  (`stream: true`) is still not traced on either API (MHQ-1407). Parity with the Python SDK.
- **`getPrompt(name, { label?, version?, ifNoneMatch?, cacheTtlSeconds? })`** fetches a hosted prompt
  from the registry (`GET /api/v1/prompts/{name}`, needs a key with the `prompts:read` scope).
  Resolves to a `Prompt` (`name, version, templateText, labels, etag`); a 304 gives
  `{ notModified: true, etag }`. Typed errors `PromptAccessError`, `PromptNotFoundError`,
  `PromptRateLimitError` (`.retryAfter`), all subclassing `PromptError`. Deliberately thin: no
  retries, no fallback.
- **`getPrompt` links the active run (UP-09).** New `link` option, default `true`: when a run is
  active at call time, the run gets a prompt reference for the fetched `name@version` tagged
  `link_source: "fetch"` (JSON `link_source`, OTLP `morse.prompt.link_source`). Applies to a 200, an SDK
  cache hit, and a 304 when the SDK holds the cached prompt (matching etag). No active run: no-op.
  Pass `{ link: false }` to opt out. Linking never throws, and the first link per process logs one
  info line. A `setPrompt` ref for the same name, version and span is deduped into one ref tagged
  "fetch". `setPrompt` refs are unchanged (no `link_source` on the wire).
- **Optional prompt cache.** `getPrompt(name, { cacheTtlSeconds })` serves a process-local LRU
  (default 256 entries); stale entries revalidate with `If-None-Match` and errors are never masked
  by stale data. Off by default (unset/`0`): no cache read or write. Passing your own `ifNoneMatch`
  bypasses it. New `configurePromptCache({ maxEntries })` and `clearPromptCache()`. We recommend
  caching in some form: call the API directly, use your own cache, or use `cacheTtlSeconds`.

- **Record keys, agent version, prompt references and git revision (MHQ-1275).**
  Additive; nothing changes for code that doesn't call them. `linkRecord(keyType, keyValue)`
  and `run({ recordKeys })` link a trace to a business record by id; `init({ agentVersion })`
  and `run({ agentVersion })` declare the agent version; `setPrompt(name, version?)` records
  the prompt used, pinned to the current span when called inside one. Inputs are validated
  client-side and dropped, never thrown (key types lower-cased and matched against
  `^[a-z0-9][a-z0-9_.-]{0,63}$`, values 1-256 characters, 20 keys and 20 prompt references
  per trace, agent version cut to 128). JSON wire: trace fields `record_keys`,
  `agent_version`, `prompts`. OTLP wire: root-span `morse.record_key.<type>` and
  `morse.agent_version`; `morse.prompt.name` / `morse.prompt.version` on the span the call was
  made in (one reference per span on OTLP: the last wins). The SDK also now sends
  `git.revision` (from `MORSE_GIT_REVISION`, `GITHUB_SHA`, `CI_COMMIT_SHA`,
  `RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`, `SOURCE_VERSION`, then
  `git rev-parse HEAD` on Node only, 500 ms cap, never in browser/edge bundles) and
  `service.version` (from `OTEL_RESOURCE_ATTRIBUTES`) as resource attributes on both wires.
  Detected once at `init()`. In Docker, set `MORSE_GIT_REVISION` at build time.
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
- **OpenAI `responses.create` is now traced by `wrapOpenAI`, with thread facts.** The `llm` span
  (`openai.responses.create`) carries `response_id`, `previous_response_id` and `conversation_id`
  (a string, or the `id` of a conversation object) in span metadata, only for the keys present.
  Streamed calls get `previous_response_id` and `conversation_id` only, since no final response
  object is available to the adapter. No new public function.
- **`init({ captureEndUser })`: opt-in end-user capture (default `false`).** When `true`, the OpenAI
  adapter reads `user` / `safety_identifier` and the Anthropic adapter reads `metadata.user_id`, and
  sets the trace `user_id` to `"h:" + sha256(value).slice(0, 32)`. The raw value is never sent, a
  `userId` the app already set wins, and `customer_id` is never set. Needs `node:crypto`, so it is
  a no-op in browser bundles. Off by default: behaviour is unchanged.

### Changed — behaviour change, no API change

- **Peer ranges are unchanged since 0.5.0.** `ai`, `openai`, `@langchain/core` etc. peer ranges are
  unchanged since 0.5.0; `ai<7` needs `--legacy-peer-deps` or SDK 0.4.x.
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
- **Infra spans never fail a trace, and queue spans are not billable** (MHQ-1404). A failed
  `db`, `http` or `queue` span stays failed on its own row, but the server no longer marks the
  whole trace failed because of it. Queue publish spans now carry the new `queue` span type
  (was `custom`) and join `db`/`http` as non-billable (ADR-033 D1).

### Added

- **HTTP capture** for `fetch` (undici) and `node:http` / `node:https`, matching Python: an `http`
  span named `METHOD host` with the response status. Path, query string, headers and bodies are
  never read. LLM provider hosts, the Morse ingest host and `MORSE_CAPTURE_HTTP_EXCLUDE_HOSTS` are
  excluded. On by default; `MORSE_CAPTURE_HTTP=0` disables. Uses `diagnostics_channel`, so it
  works in ESM and CJS and adds no dependency.
- **Queue spans.** BullMQ `Queue.add` / `addBulk` and SQS (`@aws-sdk/client-sqs`) `SendMessage*`
  inside a trace record a `queue` span `publish <destination>` with OpenTelemetry messaging
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
