# Contract tests — real agent SDKs, not fixtures

Every other test in this repo drives a hand-rolled fake. That is deliberate and
fine for behaviour, but it means the adapter suite has **no contract with the
packages it instruments**: `src/` contains no import of `@openai/agents`,
`@anthropic-ai/claude-agent-sdk`, `@langchain/*` or `ai`, all types are
structural interfaces in `src/*/types.ts`, and every runtime lookup is a
`Function("m", "return import(m)")` that returns `null` on failure.

Measured on 2026-08-05 (MHQ-935) by hiding each package from `node_modules`:

| Hidden                         | Result                     |
| ------------------------------ | -------------------------- |
| `@openai/agents`               | 80 tests pass              |
| `@langchain` + `@anthropic-ai` | 265 tests pass             |
| `ai` + `openai`                | full suite, 627 tests pass |

The whole suite is green with every instrumented SDK uninstalled. So a devDep
version bump proves nothing, and "we test against X" was never true for TS.

**These tests are the missing contract.** Each one imports the REAL package and
asserts the single structural assumption its adapter depends on — the export we
patch, the class we subclass, the function we replace. They do not test
behaviour (the fixture tests do that); they answer one question:

> Does the shape we hard-coded still exist in the installed version?

That makes a version bump meaningful for the first time: bump the devDep, and a
drifted API turns this directory red instead of silently disabling telemetry in
a customer's process (the MHQ-758 failure mode).

Keep them fast and offline — no API keys, no network, no model calls. Live
end-to-end coverage belongs in the nightly canary (`.github/workflows/canary.yml`).

When one fails after a bump, that is the signal working. Fix the adapter or move
the floor; do not delete the assertion.

## Running one framework at a time

```sh
pnpm contract                                  # everything at the pinned versions
CONTRACT_ONLY=ai pnpm contract                 # just the Vercel AI assertions
```

`CONTRACT_ONLY` exists for the nightly `latest` lanes (MHQ-930, the
`latest-contract` matrix in `canary.yml`). Each lane upgrades exactly one
framework to `@latest` on a throwaway checkout and runs only that framework's
assertions, so a red lane names the framework that broke instead of four lanes
all re-reporting the three packages still at their floor.

Filtered-out assertions report as `skip` and are counted in the summary — a lane
that quietly asserted nothing must never read like a lane that passed. A
`CONTRACT_ONLY` value matching no assertions exits non-zero for the same reason.
