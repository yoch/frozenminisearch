#!/usr/bin/env node
/**
 * Retained-heap suite under the current runtime (Node or Bun).
 * Writes to tmp/bun-results/ — does not touch official baselines.
 *
 *   node --expose-gc dev/bun/retained-heap-run.mjs
 *   bun --no-install --expose-gc dev/bun/retained-heap-run.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHeapSuite } from '../../benchmarks/framework/runHeapSuite.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'tmp/bun-results')

const isBun = typeof globalThis.Bun !== 'undefined'
const runtime = isBun ? 'bun' : 'node'
const version = isBun ? Bun.version : process.version

mkdirSync(OUT_DIR, { recursive: true })

const scenarioIds = [
  'divina-indexOnly',
  'divina-storeFields',
  'extreme-giantVocabulary',
  'extreme-largeDocuments',
  'extreme-highFrequency',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
]

const t0 = performance.now()
const suite = runHeapSuite({
  scenarioIds,
  paths: ['mutable-addAll', 'frozen-fromDocuments', 'loadBinary'],
  trials: 3,
  gcPasses: 3,
})
const elapsedSec = Number(((performance.now() - t0) / 1000).toFixed(1))

const payload = {
  capturedAt: new Date().toISOString(),
  runtime,
  version,
  execPath: process.execPath,
  elapsedSec,
  note: 'Retained heap metrics are engine-specific (V8 vs JSC). Compare Frozen vs mutable within the same runtime only.',
  heapBenchProtocol: suite.heapBenchProtocol,
  results: suite.results,
}

const out = join(OUT_DIR, `retained-heap-${runtime}.json`)
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, out, elapsedSec, scenarios: Object.keys(suite.results).length }))
