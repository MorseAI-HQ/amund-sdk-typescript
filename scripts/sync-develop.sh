#!/usr/bin/env bash
# Bring the current branch up to date with origin/develop by MERGING (never rebase, never force-push:
# develop takes squash merges, so a merge commit costs nothing and a rebase needs a force-push).
# Usage: scripts/sync-develop.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "develop" ] || [ "$branch" = "staging" ] || [ "$branch" = "main" ]; then
  echo "sync-develop: run this on a feature branch, not $branch." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "sync-develop: uncommitted changes. Commit them first (do not stash: the stash stack is shared across worktrees)." >&2
  exit 1
fi

git fetch -q origin develop
behind="$(git rev-list --count HEAD..origin/develop)"
if [ "$behind" -eq 0 ]; then
  echo "sync-develop: $branch is up to date with origin/develop."
  exit 0
fi

echo "sync-develop: merging $behind commit(s) from origin/develop into $branch..."
if ! git merge --no-edit origin/develop; then
  echo "" >&2
  echo "sync-develop: merge conflicts. Resolve them, 'git add' the files, 'git commit', then push." >&2
  echo "              To give up: git merge --abort" >&2
  exit 1
fi
echo "sync-develop: done. Re-run your checks (scripts/prepush.sh) before pushing."
