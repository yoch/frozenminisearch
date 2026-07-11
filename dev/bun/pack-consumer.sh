#!/usr/bin/env bash
# Pack the published tarball and install it into a temporary Bun consumer project.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/tmp/bun-results"
CONSUMER="/tmp/fms-bun-consumer-$$"
mkdir -p "$OUT_DIR"
cd "$ROOT"

echo "[pack] pnpm pack"
TARBALL="$(pnpm pack --pack-destination "$OUT_DIR" | tail -n1)"
echo "[pack] $TARBALL"

rm -rf "$CONSUMER"
mkdir -p "$CONSUMER"
cd "$CONSUMER"
cat > package.json <<'JSON'
{
  "name": "fms-bun-consumer",
  "private": true,
  "type": "module"
}
JSON

echo "[install] bun add $TARBALL"
bun add "$TARBALL"

cat > smoke.mjs <<'JS'
import FrozenMiniSearch from '@yoch/frozenminisearch'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const CJS = require('@yoch/frozenminisearch')

const options = { fields: ['title', 'text'], storeFields: ['title'] }
const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael' },
  { id: 2, title: 'Zen', text: 'Quality of thought' },
]

const es = FrozenMiniSearch.fromDocuments(docs, options)
const cjs = CJS.default.fromDocuments(docs, options)
const esHit = es.search('ishmael')[0]?.id
const cjsHit = cjs.search('ishmael')[0]?.id
const zlib = es.saveBinarySync({ compression: 'zlib' })
const loaded = FrozenMiniSearch.loadBinarySync(zlib, options)
const report = {
  ok: esHit === 1 && cjsHit === 1 && loaded.search('ishmael')[0]?.id === 1,
  bun: typeof Bun !== 'undefined' ? Bun.version : null,
  esHit,
  cjsHit,
  zlibBytes: zlib.byteLength,
}
console.log(JSON.stringify(report))
if (!report.ok) process.exit(1)
JS

echo "[smoke] bun smoke.mjs"
REPORT="$(bun smoke.mjs)"
echo "$REPORT" | tee "$OUT_DIR/consumer-pack-install.json"
echo "[ok] consumer pack+install under Bun"
