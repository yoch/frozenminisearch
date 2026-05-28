#!/usr/bin/env bash
# Replay benchmarks for each commit since the JSON suite was introduced (db3707b).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ORIGIN="${ORIGIN:-db3707bd1eab67700e936a0931b07f9f3eff627a}"
TO="${TO:-HEAD}"
RUNS="${RUNS:-1}"
HISTORY="$ROOT/benchmarks/perf-history.jsonl"
DRY_RUN=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    --runs=*) RUNS="${arg#*=}" ;;
    --runs) shift; RUNS="${1:-1}" ;;
  esac
done

commit_recorded () {
  local sha="$1"
  [[ -f "$HISTORY" ]] && grep -Fq "\"commit\":\"${sha}\"" "$HISTORY"
}

if [[ "$DRY_RUN" == false ]] && [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing: tracked files are modified (stash or commit first)." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD)"

mapfile -t COMMITS < <(git rev-list --reverse "${ORIGIN}^..${TO}")
MISSING=()
for sha in "${COMMITS[@]}"; do
  if [[ "$FORCE" == true ]] || ! commit_recorded "$sha"; then
    MISSING+=("$sha")
  fi
done

echo "Range: ${#COMMITS[@]} commit(s), ${#MISSING[@]} to record (runs=${RUNS})."

if [[ "$DRY_RUN" == true ]]; then
  for sha in "${MISSING[@]}"; do
    printf '  would record %s  %s\n' "$(git rev-parse --short "$sha")" "$(git log -1 --format=%s "$sha")"
  done
  exit 0
fi

record_args=(--runs "$RUNS")
[[ "$FORCE" == true ]] && record_args+=(--force)

restore_tree () {
  echo ""
  echo "Restoring ${BRANCH} @ ${HEAD_SHA:0:7}"
  git checkout "$BRANCH" >/dev/null 2>&1 || true
  git reset --hard "$HEAD_SHA" >/dev/null 2>&1 || true
  if [[ -f yarn.lock ]]; then
    yarn install --frozen-lockfile
  elif [[ -f package-lock.json ]]; then
    npm ci
  fi
}
trap restore_tree EXIT

for sha in "${MISSING[@]}"; do
  short="$(git rev-parse --short "$sha")"
  subj="$(git log -1 --format=%s "$sha")"
  echo ""
  echo ">>> ${short}  ${subj}"
  git checkout --detach "$sha" >/dev/null
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "Tracked tree dirty after checkout at ${short}; aborting." >&2
    exit 1
  fi
  if ! RUNS="$RUNS" "$SCRIPT_DIR/record-history.sh" "${record_args[@]}"; then
    echo "Failed at ${short}." >&2
    exit 1
  fi
done

trap - EXIT
restore_tree
echo "Done. History: ${HISTORY}"
