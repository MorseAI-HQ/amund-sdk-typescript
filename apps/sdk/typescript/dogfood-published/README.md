# Published-SDK E2E (`dogfood-published/`)

Verifies the **published** `@amundai/sdk` from npm — not the workspace build.
(Through 0.8.0 the package was `@morsehq-dev/sdk`; that name is now a re-export
shim, smoke-tested from the packed tarballs by `../scripts/smoke-packed.mjs`.)

`../dogfood/` imports `../src/**` (including `_internal/`), so it proves the source
tree works. It cannot catch anything that goes wrong between source and registry:
a missing `exports` entry, a file left out of `files`, a broken `dist/`, a public
API that turns out to need an internal import. This directory catches those.

## Why it is not in the pnpm workspace

Deliberately. If it were, `@amundai/sdk` would resolve to the local build and
the whole point is lost. Install it with plain `npm` in this directory:

```bash
cd apps/sdk/typescript/dogfood-published
npm install
```

Bump the pinned `@amundai/sdk` version in `package.json` when a new release
goes out — the pin is the thing under test, so it must never be a floating range
that silently resolves to something else.

## Run

```bash
export AMUND_API_KEY=...           # a dogfood org key, see bizops/dogfood/ACCOUNTS.md
export AMUND_ENDPOINT=https://dev-api.morsehq.dev/api/v1/traces/batch
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...
npm run all                        # or: npm run anthropic | openai | langgraph
```

`AMUND_ENDPOINT` (or the older `MORSE_ENDPOINT`) is required for dev. Do not copy `../dogfood/_common.ts`'s
`DEV_ENDPOINT_DEFAULT` habit — that constant points at **prod** despite its name
(see `bizops/dogfood/ACCOUNTS.md`). The default here is the dev URL.

## Verifying delivery

Exit code 0 only means the SDK did not throw. It is not proof the trace landed —
`BatchTransport` absorbs response errors, which is exactly how the Phase 13 wire
drifts stayed invisible. Confirm against the dev DB:

```sql
select w.org_id, a.name, t.framework, t.span_count, t.total_tokens, t.total_cost_usd
from traces t
join orgs_environment e on e.id = t.environment_id
join orgs_workspace w on w.id = e.workspace_id
left join agents a on a.id = t.agent_id
where t.started_at > now() - interval '15 minutes'
order by t.started_at desc;
```

## Scope

`anthropic`, `openai`, `langgraph` — one real LLM call each, via the published
public entrypoints only (`@amundai/sdk`, `@amundai/sdk/anthropic`, …).
No `_internal` imports: if a scenario here needs one, that is itself the finding.

The Python counterpart is `apps/sdk/python/dogfood-published/run.py`.
