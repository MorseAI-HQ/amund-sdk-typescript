# Morse TypeScript SDK

Unified observability for AI agents and infrastructure — Node backend, one SDK.

> **Built for Node; safe to bundle for the browser.** The full feature set
> targets Node.js backends (Node 18.19+ or 20.6+). Bundlers that build for
> the browser automatically resolve the `"browser"` export condition to a
> browser-safe build — no aliasing, no `resolve.fallback`, no config of any
> kind on your side. This matters in practice for full-stack frameworks
> (Next.js, Remix, SvelteKit) where the same import is compiled for both
> the server and the client.
>
> In that browser build, `run()` / `span()` / `track()` / `record()` and W3C
> `traceparent` propagation behave exactly as documented, with traces sent
> over Morse's JSON transport. Three things are Node-only and quietly
> inactive in a browser, because they have no browser equivalent:
> OpenTelemetry OTLP span export, database capture (pg / mysql2
> instrumentation), and zero-config adapter auto-detect — which hooks
> `require()`, and a browser has none. The SDK says so once on `init()`
> rather than leaving you to wonder.
>
> This is bundle compatibility for full-stack apps, not a client-side
> analytics product: there is no session replay, no RUM, and no
> browser-specific instrumentation.

## Install

```bash
npm install @morsehq-dev/sdk
```

Adapters are peer dependencies — install only the SDKs you actually
use (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`,
`@openai/agents`, `@langchain/core`, `@langchain/langgraph`, `ai`).
Nothing else is pulled in for adapters you don't use.

## Quick Start

```ts
import * as morse from "@morsehq-dev/sdk";

morse.init({ apiKey: process.env.MORSE_API_KEY });

morse.record({
  agent: "lead-qualifier",
  success: true,
  outcome: "qualified",
  cost: 0.043,
});
```

Or trace a multi-step run:

```ts
await morse.run({ agentName: "lead-qualifier" }, async (handle) => {
  await morse.spanAsync({ name: "fetch-lead", type: "tool" }, async () => {
    /* ... */
  });
  handle.setOutcome(true, "qualified");
});
```

`record()`/`run()`/`span()` all send real OpenTelemetry spans over OTLP
by default — see [Transport](#transport) below.

## Zero-config instrumentation

Once `morse.init()` runs (or `MORSE_API_KEY` is set in the environment),
the SDK scans for already-loaded — and lazily requires — supported
libraries and wraps them automatically. Today that covers
`@anthropic-ai/sdk` and the Vercel AI SDK (`ai`); every call already
loaded or `require()`d after init gets traced with no further code
changes. Opt out with `MORSE_DISABLE_AUTO_DETECT=1`.

The other adapters below (`anthropic-agent-sdk`, `openai-agents`,
`langgraph`, `langchain`) don't have a zero-config path yet — call
their wrap function explicitly, once, at startup. The SDK logs a
one-time hint naming the exact call when it detects one of these
installed without being wrapped.

## Adapters

Each adapter is a separate subpath export so you only pull in what you
use.

### Supported versions

We verify two versions of each agent SDK — the declared floor and the
current latest. Versions between them are expected to work but are not
verified; below the floor is unsupported. Policy:
`engineering/SDK_VERSION_SUPPORT.md`.

Both ends are real checks, not lockfile trivia. `pnpm contract`
(`tests/contract/`) loads the actual installed package on every PR and
asserts the structural thing each adapter depends on — the export we patch,
the class we subclass, the function we replace. The nightly `latest-contract`
lanes in `.github/workflows/canary.yml` run the same assertions against
whatever upstream published most recently, so a breaking release surfaces the
night it ships rather than in a customer's process.

| Peer                             | Declared   | Floor (verified per PR) | Latest (verified nightly) |
| -------------------------------- | ---------- | ----------------------- | ------------------------- |
| `ai` (Vercel AI SDK)             | `>=7.0.0`  | 7.0.55                  | 7.0.55                    |
| `openai`                         | `>=6.0.0`  | 6.49.0                  | —                         |
| `@anthropic-ai/sdk`              | `>=0.90.0` | 0.96.0                  | —                         |
| `@anthropic-ai/claude-agent-sdk` | `>=0.3.0`  | 0.3.223                 | 0.3.223                   |
| `@openai/agents`                 | `>=0.2.0`  | 0.2.1                   | blocked — see below       |
| `@langchain/core`                | `>=1.0.0`  | 1.2.5                   | 1.2.5                     |
| `@langchain/langgraph`           | `>=1.0.0`  | 1.4.9                   | 1.4.9                     |

Floor and latest coincide today because the pins were just raised to the
newest verified versions; they diverge again as soon as upstream ships.

`@openai/agents` is held at the `0.2.x` line deliberately: 0.5.0 and later
require peer `zod ^4`, and this monorepo is on zod 3 (MHQ-935).

`openai` and `@anthropic-ai/sdk` have no nightly `latest` lane yet — their
floors are verified per PR, but nothing watches upstream for them (MHQ-930).

### `@morsehq-dev/sdk/anthropic` — Anthropic Messages API

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "@morsehq-dev/sdk/anthropic";

const client = wrapAnthropic(new Anthropic());
// every messages.create call now emits an `llm` span automatically
```

Auto-installed by zero-config detection too — `wrapAnthropic()` is a
no-op on a client if a global auto-detect install is already active
(no double-recording). Pass `{ summarize: true }` to also emit a
sibling `memory` span per call.

### `@morsehq-dev/sdk/anthropic-agent-sdk` — Claude Agent SDK

Wrap the package's top-level `query` and call the returned function in its
place. Emits an outer **agent** span, per-call **llm** spans (with
`context_segments`), **tool** spans, **subagent.spawn** spans for Task-tool
fan-out, and **hook** spans.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { wrapClaudeAgentQuery } from "@morsehq-dev/sdk/anthropic-agent-sdk";

const tracedQuery = wrapClaudeAgentQuery(query);

for await (const message of tracedQuery({ prompt: "research the 2026 RLHF landscape" })) {
  // your code unchanged — spans flow to Morse as a side-effect
}
```

The returned value is still a `Query`: `interrupt()`, `setPermissionMode()`
and every other control method are forwarded to the real one, so wrapping
costs you nothing at the call site.

Why a wrapper rather than zero-config auto-detect: the package's `query`
export is read-only and non-configurable, so there is nothing to patch in
place — the same constraint the Vercel AI adapter hit. Auto-detect notices
the package and logs a one-time hint pointing here.

### `@morsehq-dev/sdk/openai-agents` — OpenAI Agents SDK

Wraps `Runner` from `@openai/agents`. Emits an outer **agent** span,
**llm** + **tool** spans, **subagent.spawn**-shaped spans for
`handoff` events, and **guardrail** spans with pass/fail status.

```ts
import { Runner, Agent } from "@openai/agents";
import { wrapRunnerWithFullInstrumentation } from "@morsehq-dev/sdk/openai-agents";

const raw = new Runner();
const { runner, dispose } = wrapRunnerWithFullInstrumentation(raw);
const agent = new Agent({ name: "triage", model: "gpt-4o" /* ... */ });
await runner.run(agent, userInput);
dispose();
```

### `@morsehq-dev/sdk/langgraph` — LangGraph JS

`MorseCallbackHandler`, a `BaseCallbackHandler` you pass via
`callbacks`. Emits **agent** spans per chain (nested chains nest
properly), **llm** + **tool** spans, and aggregates streaming tokens
onto the parent llm span rather than emitting per-token spans.

```ts
import { MorseCallbackHandler } from "@morsehq-dev/sdk/langgraph";

const handler = new MorseCallbackHandler();
const result = await graph.invoke(input, { callbacks: [handler] });
```

### `@morsehq-dev/sdk/langchain` — plain LangChain (chains, LLMs, tools, retrievers)

`MorseCallbackHandler` for `@langchain/core` outside a LangGraph graph
— a structural sibling of the `langgraph` adapter, not a subclass.
Doesn't auto-create a trace when none is active; wrap the invocation in
`morse.run()`/`runAsync()`.

```ts
import { MorseCallbackHandler } from "@morsehq-dev/sdk/langchain";
import { runAsync } from "@morsehq-dev/sdk";

const handler = new MorseCallbackHandler({ agentName: "my-agent" });
await runAsync({ agentName: "my-agent" }, async () => {
  await chain.invoke(input, { callbacks: [handler] });
});
```

### `@morsehq-dev/sdk/vercel-ai` — Vercel AI SDK

One `agent` span per top-level `streamText` / `generateText` /
`generateObject` invocation. **Not** zero-config auto-detected — `ai`'s
named exports are non-configurable getters on its module namespace (it
ships pure ESM), so there is nothing a monkey-patch can reassign, unlike
`@anthropic-ai/sdk`'s `Messages.prototype.create`. Resolve traced
replacement functions once and call those instead of `ai`'s own:

```ts
import { createTracedVercelAI } from "@morsehq-dev/sdk/vercel-ai";

const { streamText, generateText, generateObject } = await createTracedVercelAI();
// use streamText(...) / generateText(...) / generateObject(...) exactly
// like ai's own — same call signature, same return shape.
```

### `@morsehq-dev/sdk/integrations/pino` — pino log forwarding

Ship pino log lines to Morse, auto-correlated with the active trace.

```ts
import pino from "pino";
import { morsePinoDestination } from "@morsehq-dev/sdk/integrations/pino";

const logger = pino(
  { level: "info" },
  pino.multistream([{ stream: process.stdout }, { stream: morsePinoDestination() }]),
);
```

### Shared metadata schema

The agent-SDK adapters (`anthropic-agent-sdk`, `openai-agents`,
`langgraph`, `langchain`) tag every span with
`metadata.adapter ∈ {"anthropic-agent-sdk", "openai-agents", "langgraph-js", "langchain-js"}`.
Span types use the same vocabulary regardless of source adapter —
dashboards never branch on adapter origin. `subagent.spawn` and `hook`
are modeled as `type=agent` + `metadata.spawn_kind="subagent"` and
`type=tool` + `metadata.tool_kind="hook"` respectively until the
backend `SpanType` enum gains native variants.

## Cost

`cost_usd` is computed automatically from the model + token counts on
every `llm` span the adapters above emit, using a bundled pricing
table — no separate call needed, and an explicit value the adapter
already knows (e.g. from a provider response) always wins over the
computed one. `record()` doesn't auto-compute — pass `cost` yourself
if you have it.

## Infra auto-capture (opt-in)

Zero-config `db` spans for Postgres (`pg`), MySQL (`mysql2`), and
SQLite (`better-sqlite3`) — correlated with the active `morse.span()`/
`morse.run()` via real OpenTelemetry context propagation. Off by
default; enable with `MORSE_CAPTURE_DB=1` (or `MORSE_CAPTURE_INFRA=1`).
No code changes needed beyond the env var — the SDK registers the
matching community OTel instrumentation package for whichever driver
is actually installed.

## Transport

`run()`/`span()`/`record()` emit real `@opentelemetry/sdk-trace-node`
spans over OTLP (protobuf+gzip) — the same transport architecture as
the Python SDK. `MORSE_LEGACY_TRANSPORT=1` reverts to a plain
JSON-over-fetch batcher as an escape hatch during a migration window;
you shouldn't need it. `track()`/`batchTrack()` are a lower-level,
non-trace-shaped escape hatch of their own — prefer `record()`.

## PII Redaction

Client-side redaction, **default-on**. Sensitive strings (API keys,
JWTs, credit-card numbers, SSNs, emails, phone numbers) are rewritten
to `[REDACTED:<kind>]` markers inside your process before any data
leaves for the Morse ingest endpoint. The same pattern catalogue ships
in the Python SDK and the server-side ingest layer.

```ts
import { init } from "@morsehq-dev/sdk";

init({
  apiKey: process.env.MORSE_API_KEY,
  redaction: {
    enabled: true, // default
    disabledPatterns: ["email"], // turn off email-only
    extraPatterns: ["INTERNAL-[\\w-]+"],
  },
});
```

- **Mandatory patterns cannot be disabled at the SDK.** Trying to
  disable `api_key_prefixed`, `jwt`, `credit_card`, or `ssn_us` makes
  `init()` throw at construction time.
- **Invalid extra regexes throw at `init()`.** Each entry must compile
  via `new RegExp(...)`; the array must be ≤ 10 entries, each pattern
  ≤ 256 characters.
- **Disabling redaction at the SDK does NOT bypass the server.** The
  ingest layer always re-runs the mandatory pattern set before writing
  anything to durable storage.

| Key                 | Match                                                                                                                                | Replacement              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `api_key_prefixed`  | `sk-…`, `sk_(live\|test)_…`, `mhq_…`, `ghp_…`, `xox[bopsa]-…`, `AKIA…`, etc.                                                         | `[REDACTED:api_key]`     |
| `jwt`               | `eyJ…<dot>eyJ…<dot>…` (≥16 chars per segment)                                                                                        | `[REDACTED:jwt]`         |
| `credit_card`       | 13–19 digit groups passing Luhn                                                                                                      | `[REDACTED:credit_card]` |
| `email`             | RFC-5322-ish `local@domain.tld`                                                                                                      | `[REDACTED:email]`       |
| `phone_us`          | US phone formats                                                                                                                     | `[REDACTED:phone]`       |
| `phone_e164`        | International E.164                                                                                                                  | `[REDACTED:phone]`       |
| `ssn_us`            | `999-99-9999` (with standard exclusions)                                                                                             | `[REDACTED:ssn]`         |
| `ip_address`        | IPv4 + IPv6 — **default OFF** (often legitimate metadata)                                                                            | `[REDACTED:ip]`          |
| `secret_assignment` | `password=` / `client_secret:` / `authorization: Bearer …` / `PGPASSWORD=`. Excludes token _counts_ (`input_tokens=`, `max_tokens=`) | `[REDACTED:secret]`      |

## Docs

Full reference — every adapter, all `init()` options, configuration,
troubleshooting — lives at **[docs.morsehq.dev](https://docs.morsehq.dev)**.
This README stays a quickstart.

## Naming

The npm package is `@morsehq-dev/sdk` (the npm org that exists is
`morsehq-dev` — npm ties a package scope 1:1 to its owning org login).
`@morsehq/sdk` is only the internal pnpm workspace identifier used
inside this monorepo; it is never the published registry name.
