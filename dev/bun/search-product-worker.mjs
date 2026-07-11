#!/usr/bin/env node
/**
 * Measure public search from one built product tree.
 *
 * The worker intentionally imports only dist/cjs from --product-root. It does
 * not mix a published bundle with source internals from another variant.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { caseByKey } from './search-cases.mjs'

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find(arg => arg.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function percentile (values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function stableValue (value, scoreDigits = null, key = '', omitScore = false) {
  if (Array.isArray(value)) {
    return value.map(item => stableValue(item, scoreDigits, '', omitScore))
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter(childKey => !omitScore || childKey !== 'score')
        .sort()
        .map(childKey => [
          childKey,
          stableValue(value[childKey], scoreDigits, childKey, omitScore),
        ]),
    )
  }
  if (scoreDigits != null && key === 'score' && typeof value === 'number') {
    return Number(value.toFixed(scoreDigits))
  }
  return value
}

function hashText (text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function checksum (value) {
  const strict = JSON.stringify(stableValue(value))
  const tolerant = JSON.stringify(stableValue(value, 5))
  const shape = JSON.stringify(stableValue(value, null, '', true))
  return {
    hash: hashText(strict),
    tolerantHash: hashText(tolerant),
    shapeHash: hashText(shape),
    bytes: strict.length,
    count: Array.isArray(value) ? value.length : null,
  }
}

function calibrateBatch (fn, targetMs, maxBatch = 4096) {
  const started = performance.now()
  fn()
  const oneCallMs = Math.max(performance.now() - started, 1e-6)
  let batchSize = Math.min(maxBatch, Math.max(1, Math.ceil(targetMs / oneCallMs)))
  const calibrationStarted = performance.now()
  for (let i = 0; i < batchSize; i++) fn()
  const calibrationMs = Math.max(performance.now() - calibrationStarted, 1e-6)
  batchSize = Math.min(
    maxBatch,
    Math.max(1, Math.round(batchSize * targetMs / calibrationMs)),
  )
  return batchSize
}

function measure (fn, { batchSize, warmup, iterations }) {
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    for (let batch = 0; batch < batchSize; batch++) sink += fn().length
  }
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const started = performance.now()
    for (let batch = 0; batch < batchSize; batch++) sink += fn().length
    samples.push((performance.now() - started) / batchSize)
  }
  const p50 = median(samples)
  return {
    p50: Number(p50.toFixed(6)),
    p95: Number(percentile(samples, 0.95).toFixed(6)),
    mad: Number(median(samples.map(value => Math.abs(value - p50))).toFixed(6)),
    batchSize,
    batchDurationMs: Number((p50 * batchSize).toFixed(3)),
    iterations,
    sink,
  }
}

const caseKey = argValue('case')
const productRoot = argValue('product-root')
const warmup = Number(argValue('warmup') || 20)
const iterations = Number(argValue('iterations') || 30)
const targetMs = Number(argValue('target-ms') || 25)

if (caseKey == null || productRoot == null) {
  throw new Error('Usage: --case=<key> --product-root=<worktree>')
}

const caze = caseByKey(caseKey)
if (caze == null) throw new Error(`Unknown case: ${caseKey}`)

const require = createRequire(import.meta.url)
const productModule = require(resolve(productRoot, 'dist/cjs/index.cjs'))
const FrozenMiniSearch = productModule.default ?? productModule.FrozenMiniSearch ?? productModule
const frozen = caze.kind === 'medicaments'
  ? FrozenMiniSearch.loadBinarySync(readFileSync(caze.file), {})
  : FrozenMiniSearch.fromDocuments(caze.corpus, caze.options)
const search = () => frozen.search(caze.query, caze.opts)

search()
const memoryBefore = process.memoryUsage()
const batchSize = calibrateBatch(search, targetMs)
const timing = measure(search, { batchSize, warmup, iterations })
const results = search()
const memoryAfter = process.memoryUsage()
const isBun = typeof globalThis.Bun !== 'undefined'

console.log(JSON.stringify({
  ok: true,
  runtime: isBun ? 'bun' : 'node',
  runtimeVersion: isBun ? Bun.version : process.version,
  caseKey,
  productRoot,
  timing,
  checksum: checksum(results),
  memory: {
    rssBefore: memoryBefore.rss,
    rssAfter: memoryAfter.rss,
    rssDelta: memoryAfter.rss - memoryBefore.rss,
    heapUsedBefore: memoryBefore.heapUsed,
    heapUsedAfter: memoryAfter.heapUsed,
  },
  gateProbe: caze.gateProbe ?? null,
}))
