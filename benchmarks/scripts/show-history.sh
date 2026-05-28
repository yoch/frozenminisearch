#!/usr/bin/env bash
# Compact view of benchmarks/perf-history.jsonl
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HISTORY="$ROOT/benchmarks/perf-history.jsonl"

if [[ ! -f "$HISTORY" ]]; then
  echo "No $HISTORY — run record-history.sh first." >&2
  exit 1
fi

node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const history = join(dirname(fileURLToPath(import.meta.url)), '../perf-history.jsonl')
const lines = readFileSync(history, 'utf8').split('\n').filter(Boolean)

const pad = (s, n) => String(s ?? '—').padEnd(n).slice(0, n)
console.log(
  pad('COMMIT', 8) +
  pad('DATE', 22) +
  pad('SCEN', 5) +
  pad('HEAP', 7) +
  pad('LOAD', 8) +
  pad('FREEZE', 8) +
  pad('MAGIC', 7) +
  'scenario'
)

for (const line of lines) {
  const e = JSON.parse(line)
  const s = e.scenarios?.find((x) => x.id === 'divina-indexOnly')
  console.log(
    pad(e.git?.commitShort, 8) +
    pad((e.git?.commitDate ?? '').slice(0, 19), 22) +
    pad(e.scenarios?.length, 5) +
    pad(s?.heapMb?.frozen, 7) +
    pad(s?.loadMs?.binary, 8) +
    pad(s?.indexing?.freezeMs, 8) +
    pad(s?.indexing?.binaryMagic, 7) +
    'divina-indexOnly'
  )
}
EOF
