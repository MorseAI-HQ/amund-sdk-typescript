# Changelog

All notable changes to `@morsehq-dev/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The TypeScript and Python SDKs version **independently** — they share `0.4.0` as
their first public release because they reached feature parity there, not
because they are released in lockstep. Expect the numbers to diverge.

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
