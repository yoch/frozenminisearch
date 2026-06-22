#!/usr/bin/env bash
# Record benchmark snapshot at HEAD into benchmarks/perf-history.jsonl (clean tree only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing: tracked files are modified. Commit or stash first." >&2
  exit 1
fi

if ! node --expose-gc -e "if(!global.gc)process.exit(1)" 2>/dev/null; then
  echo "Warning: run with node --expose-gc for stable heap." >&2
fi

if [[ -f pnpm-lock.yaml ]]; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
elif [[ -f package-lock.json ]]; then
  npm ci 2>/dev/null || npm install
  git checkout -- package-lock.json 2>/dev/null || true
fi

pnpm build
exec node --expose-gc "$(dirname "$0")/record-history.mjs" "$@"
