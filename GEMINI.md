# GEMINI.md — Morse (morse-sdk-typescript)

Antigravity / Gemini reads this file automatically when you open `morse-sdk-typescript` on any machine.

## 1. Overarching Startup Context & Live Progress (Auto-Included)

@[Morse Persistent Context](../morse-bizops/GEMINI.md)

If `../morse-bizops/GEMINI.md` was not auto-inlined (for example, in a standalone clone), read these sibling files at session start before taking action:
- `../morse-bizops/GEMINI.md` — canonical overarching goals, live launch state, positioning/claim guardrails, ICP/pricing, mid-Nov research convergence, and source index.
- `../morse-bizops/bizops/gtm/launch/2026-11/launch-tracker.md` — living dated launch milestones and blockers.
- `../morse-core/CLAUDE.md` & `../morse-core/AGENTS.md` — cross-repo operating rules, git flow, approval gates, and decision logging.
- `../morse-core/engineering/OPERATING_CARD.md` — environments, URLs, commands, and non-negotiable guardrails.

## 2. Repo Scope & Local Authoritative Docs (`morse-sdk-typescript`)

- **Role:** TypeScript SDK (`@morsehq-dev/sdk` on npm) and Vercel AI SDK adapter.
- **Read locally:**
- `README.md`
- `apps/sdk/typescript/CLAUDE.md`
- `apps/sdk/typescript/README.md`

Discuss approach options with the founder before changing the public SDK contract. `api.morsehq.dev` stays supported indefinitely.

## 3. Shared Agent Ledger (MANDATORY — Every Session, Every Machine)

Other agents (Claude Code, Codex, Cowork, Gemini) on multiple MacBooks work on Morse concurrently. Before any work (when `../morse-core` is present):

```bash
python3 ../morse-core/scripts/ledger.py brief
```

Log status as you go with `--agent gemini` (`--domain core` for engineering/ops/docs/SDKs; `--domain bizops` for GTM/marketing/strategy; contract: `../morse-core/engineering/AGENT_LEDGER.md`):

```bash
python3 ../morse-core/scripts/ledger.py start "what you are doing" --agent gemini --domain core --ws <workstream>
python3 ../morse-core/scripts/ledger.py log progress "milestone" --agent gemini --domain core --refs MHQ-123
python3 ../morse-core/scripts/ledger.py end "where it stands, what is next" --agent gemini --domain core
```

## 4. Non-Negotiable Guardrails (Standalone Fallback)

- **Production is off-limits** (no `main` merges, prod deploys, or prod DB/env actions) without explicit same-session founder approval.
- **Claim hygiene:** Never fuse outcomes, spend, and sampled quality; never count unlabeled runs as failures; never claim unsupported root cause, auto-fix, or flagged/unshipped features as GA.
- **Provider policy:** Customer/partner content goes only to OpenAI commercial API (`OpenAI Decisions`); never send partner data to Anthropic until commercial API + sub-processor listing + 30-day notice are complete.
- **Cross-domain & secrets:** Every edit lands on a feature branch + PR to `develop` tagged `[cross-domain: Gemini]`. Never commit secrets, credentials, or customer PII.
