# TS SDK dogfood scripts (Phase 13)

Three single-shot scripts that exercise the new TS agent-SDK adapters against real LLM APIs and send traces to the Morse dev env. Internal validation (Phase A in `bizops/dogfood/oss-repo-landscape.md` §1) — finds JS-SDK bugs cheaply before the third-party showcase forks (Phase B) consume the adapters.

## Why these exist

- The integration tests under `tests/agent-sdk/*/integration.test.ts` exercise the adapters against **mock** fixtures. These scripts exercise them against the **real** Anthropic / OpenAI / LangGraph SDKs.
- Each script runs in <30 seconds and emits a small, predictable trace tree to the Morse dev env. You can re-run them on a cron to generate organic traffic.
- Bugs the mock tests miss (timing, real-event ordering, SDK shape drift) surface here first.

## Prerequisites

1. Provider API keys exported in your shell:

   ```sh
   export ANTHROPIC_API_KEY=sk-ant-...
   export OPENAI_API_KEY=sk-...
   ```

2. Morse dogfood org API key for the dev env:

   ```sh
   export MORSE_API_KEY=mhq_dev_...
   # Optional — defaults to the Railway dev URL below.
   export MORSE_ENDPOINT=https://api.morsehq.dev/api/v1/traces/batch
   ```

3. SDK deps installed:
   ```sh
   cd apps/sdk/typescript
   pnpm install
   ```

## Run

```sh
# From apps/sdk/typescript/
pnpm dogfood:anthropic    # ~3 spans
pnpm dogfood:openai       # ~5 spans
pnpm dogfood:langgraph    # ~3 spans
pnpm dogfood:all          # all three
```

Each script prints the trace id it emitted; check `https://app-docs.morsehq.dev/traces/{traceId}` (dev dashboard) to see the rendered tree.

## Cost

Each run uses ~500–2000 tokens of provider time. Default models are small (Claude Haiku, GPT-4o-mini, GPT-4o-mini via LangChain). At list rates that's well under $0.01 per full `dogfood:all` run. Safe to cron at 5–15 minute intervals if you want continuous organic-traffic synthesis.

## Wiring into a cron

Not auto-scheduled by this commit. To add a periodic dogfood probe, drop a GitHub Actions workflow under `.github/workflows/sdk-ts-dogfood-dev.yml` with a `schedule:` trigger and the three secrets configured at the org level. The Python dogfood probes in `apps/api/apps/dogfood/` are the reference pattern.
