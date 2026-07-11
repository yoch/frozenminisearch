#!/usr/bin/env node
/**
 * Isolated CPU worker for one scenario. Prints one JSON line to stdout.
 *
 *   node --expose-gc dev/bun/cpu-worker.mjs --scenario=divina-indexOnly
 *   bun --expose-gc --no-install dev/bun/cpu-worker.mjs --scenario=divina-indexOnly
 */
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import { getScenarioById } from '../../benchmarks/scenarioRegistry.mjs'
import { timedMs, gc } from '../../benchmarks/benchmarkUtils.js'

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

function runtimeInfo () {
  const isBun = typeof globalThis.Bun !== 'undefined'
  return {
    runtime: isBun ? 'bun' : 'node',
    version: isBun ? Bun.version : process.version,
    execPath: process.execPath,
  }
}

function median (xs) {
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function timeMedian (fn, runs) {
  const samples = []
  for (let i = 0; i < runs; i++) {
    gc()
    samples.push(timedMs(fn).ms)
  }
  return Number(median(samples).toFixed(3))
}

const scenarioId = argValue('scenario')
const runs = Number(argValue('runs') || 3)
const searchIters = Number(argValue('search-iters') || 50)
if (!scenarioId) {
  console.error('missing --scenario=')
  process.exit(2)
}

const scenario = getScenarioById(scenarioId)
if (!scenario) {
  console.error(`unknown scenario ${scenarioId}`)
  process.exit(2)
}

const { corpus, options, queries } = scenario
const info = runtimeInfo()

gc()
const fromDocumentsMs = timeMedian(
  () => FrozenMiniSearch.fromDocuments(corpus, options),
  runs,
)

gc()
const mutable = new MiniSearch(options)
mutable.addAll(corpus)
const json = JSON.stringify(mutable.toJSON())
const fromJsonMs = timeMedian(
  () => FrozenMiniSearch.fromJSON(json, options),
  runs,
)

gc()
const frozen = FrozenMiniSearch.fromDocuments(corpus, options)
const saveBinaryMs = timeMedian(
  () => frozen.saveBinarySync({ compression: 'zlib' }),
  runs,
)
const binaryBuf = frozen.saveBinarySync({ compression: 'zlib' })
const loadBinaryMs = timeMedian(
  () => FrozenMiniSearch.loadBinarySync(binaryBuf, options),
  runs,
)

const searchIndex = FrozenMiniSearch.loadBinarySync(binaryBuf, options)
const search = []
for (const { label, q, opts } of queries) {
  // warmup
  for (let i = 0; i < 5; i++) searchIndex.search(q, opts)
  const samples = []
  for (let i = 0; i < searchIters; i++) {
    const t0 = performance.now()
    const hits = searchIndex.search(q, opts)
    samples.push(performance.now() - t0)
    // keep work live
    if (hits.length < 0) throw new Error('unreachable')
  }
  search.push({
    label,
    query: q,
    opts,
    p50Ms: Number(median(samples).toFixed(4)),
    hitCount: searchIndex.search(q, opts).length,
  })
}

const report = {
  ok: true,
  ...info,
  scenarioId,
  documentCount: corpus.length,
  runs,
  searchIters,
  metrics: {
    fromDocumentsMs,
    fromJsonMs,
    saveBinaryMs,
    loadBinaryMs,
    search,
  },
  checksum: {
    termCount: searchIndex.termCount,
    documentCount: searchIndex.documentCount,
    binaryBytes: binaryBuf.byteLength,
  },
}

console.log(JSON.stringify(report))
