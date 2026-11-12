#!/usr/bin/env bash
# Pre-push gate (runs from the `prepush-checks` pre-commit hook on `git push`).
#
# PR CI is deliberately lean; pushes cost nothing locally, so the fast checks run here, scoped to the diff
# against origin/develop. Runs type-check, lint and vitest when SDK code changed.
# Not run here (CI / promotion cover them): build, browser-bundle check and npm pack dry-run (CI covers them).
#
# Env: PREPUSH_BASE (default origin/develop).
# Skip once, knowingly: SKIP=prepush-checks git push   (never --no-verify; see CLAUDE.md)
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
BASE="${PREPUSH_BASE:-origin/develop}"
START=$(date +%s)
say() { printf 'prepush: %s\n' "$*"; }

git fetch -q origin develop 2>/dev/null || say "could not fetch origin/develop (offline?); using the last fetched copy"
if ! git rev-parse -q --verify "$BASE" >/dev/null; then say "no $BASE ref; skipping"; exit 0; fi
base="$(git merge-base HEAD "$BASE" 2>/dev/null || true)"
if [ -z "$base" ]; then say "no merge-base with $BASE; skipping"; exit 0; fi

behind="$(git rev-list --count "HEAD..$BASE")"
if [ "$behind" -gt 0 ]; then
  say "WARNING: branch is $behind commit(s) behind develop. Run scripts/sync-develop.sh, then push again (not blocking)."
fi

changed="$(git diff --name-only --diff-filter=ACMR "$base"...HEAD)"
if [ -z "$changed" ]; then say "no changes vs develop, nothing to check"; exit 0; fi

if ! echo "$changed" | grep -qE '^(apps/|packages/|scripts/|pnpm-lock\.yaml$|package\.json$)'; then
  say "no SDK changes; nothing to run"; exit 0
fi
if [ ! -d node_modules ]; then
  say "no node_modules; running pnpm install --frozen-lockfile (first push in this checkout)"
  pnpm install --frozen-lockfile
fi
say "type-check"
pnpm type-check
say "lint"
pnpm lint
say "vitest"
pnpm --filter @morsehq/sdk exec vitest run --maxWorkers=1

say "ok ($(( $(date +%s) - START ))s)"
