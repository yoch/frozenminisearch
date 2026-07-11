#!/usr/bin/env node
/**
 * A/B worker: baseline vs treatment for one case / one variant.
 *
 * Variants:
 *   gating-off       — executeRaw vs disableGating
 *   gate-policy      — default postingGatePolicy vs tuned {minLength,ratioShift}
 *   search-vs-raw    — public search vs executeRaw+finalizeRaw (sanity)
 *   fuzzy-scratch    — packedRadixVisitFuzzyRefs without vs with reused scratch
 *   noop-control     — identical finalizeRaw closure on both sides
 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  executeRaw,
  executeRawWithRunOptions,
  finalizeRaw,
  frozenTermIndex,
} from '../../benchmarks/harness/frozenSourceInternals.ts'
import { packedRadixVisitFuzzyRefs } from '../../src/PackedRadixTree/fuzzy.ts'
import { caseByKey } from './search-cases.mjs'

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

function forceGc () {
  if (typeof globalThis.gc === 'function') globalThis.gc()
  else if (typeof globalThis.Bun !== 'undefined' && typeof Bun.gc === 'function') Bun.gc(true)
}

function median (xs) {
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function calibrateBatch (fn, targetMs = 25, maxBatch = 4096) {
  const t0 = performance.now()
  fn()
  const one = Math.max(performance.now() - t0, 1e-6)
  let batch = Math.min(maxBatch, Math.max(1, Math.ceil(targetMs / one)))
  const t1 = performance.now()
  for (let i = 0; i < batch; i++) fn()
  const elapsed = Math.max(performance.now() - t1, 1e-6)
  return Math.min(maxBatch, Math.max(1, Math.round(batch * (targetMs / elapsed))))
}

function timedBatch (fn, { warmup, iterations, batchSize }) {
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    for (let b = 0; b < batchSize; b++) {
      const v = fn()
      sink += v?.size ?? v?.length ?? (typeof v === 'number' ? v : 0)
    }
  }
  forceGc()
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    for (let b = 0; b < batchSize; b++) {
      const v = fn()
      sink += v?.size ?? v?.length ?? (typeof v === 'number' ? v : 0)
    }
    samples.push((performance.now() - t0) / batchSize)
  }
  const med = median(samples)
  return { p50: Number(med.toFixed(6)), batchSize, iterations, sink }
}

function stableValue (value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    )
  }
  return value
}

function checksumHits (hits) {
  const text = JSON.stringify(stableValue(hits))
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return { count: hits.length, hash: (h >>> 0).toString(16), bytes: text.length }
}

function buildFrozen (caze) {
  if (caze.kind === 'medicaments') {
    return FrozenMiniSearch.loadBinarySync(readFileSync(caze.file), {})
  }
  return FrozenMiniSearch.fromDocuments(caze.corpus, caze.options)
}

function primaryTerm (query) {
  const tokenize = FrozenMiniSearch.getDefault('tokenize')
  const processTerm = FrozenMiniSearch.getDefault('processTerm')
  const tokens = tokenize(String(query))
    .flatMap((t) => {
      const p = processTerm(t)
      return Array.isArray(p) ? p : [p]
    })
    .filter(Boolean)
  return tokens[0] ?? String(query)
}

const caseKey = argValue('case')
const variant = argValue('variant') || 'gating-off'
const warmup = Number(argValue('warmup') || 20)
const iterations = Number(argValue('iterations') || 30)
const targetMs = Number(argValue('target-ms') || 25)
const measurementOrder = argValue('order') || 'baseline-first'
const policyMin = Number(argValue('minLength') || 1024)
const policyShift = Number(argValue('ratioShift') || 2)

if (!caseKey) {
  console.error('missing --case=')
  process.exit(2)
}
const caze = caseByKey(caseKey)
if (!caze) {
  console.error(`unknown case ${caseKey}`)
  process.exit(2)
}

const isBun = typeof globalThis.Bun !== 'undefined'
const frozen = buildFrozen(caze)
const q = caze.query
const opts = caze.opts
frozen.search(q, opts)

let baselineFn
let treatmentFn
let checksumMatch = true
let meta = {}

if (variant === 'gating-off') {
  baselineFn = () => executeRaw(frozen, q, opts)
  treatmentFn = () => executeRawWithRunOptions(frozen, q, opts, { disableGating: true })
  const a = checksumHits(finalizeRaw(frozen, baselineFn(), q, opts))
  const b = checksumHits(finalizeRaw(frozen, treatmentFn(), q, opts))
  checksumMatch = a.hash === b.hash && a.count === b.count
  meta = { a, b }
} else if (variant === 'gate-policy') {
  const policy = { minLength: policyMin, ratioShift: policyShift }
  baselineFn = () => executeRaw(frozen, q, opts)
  treatmentFn = () => executeRawWithRunOptions(frozen, q, opts, { postingGatePolicy: policy })
  const a = checksumHits(finalizeRaw(frozen, baselineFn(), q, opts))
  const b = checksumHits(finalizeRaw(frozen, treatmentFn(), q, opts))
  checksumMatch = a.hash === b.hash && a.count === b.count
  meta = { policy, a, b }
} else if (variant === 'search-vs-raw') {
  baselineFn = () => frozen.search(q, opts)
  treatmentFn = () => finalizeRaw(frozen, executeRaw(frozen, q, opts), q, opts)
  const a = checksumHits(baselineFn())
  const b = checksumHits(treatmentFn())
  checksumMatch = a.hash === b.hash && a.count === b.count
  meta = { a, b }
} else if (variant === 'fuzzy-scratch') {
  const term = primaryTerm(q)
  const maxDistance = typeof opts.fuzzy === 'number'
    ? Math.floor(opts.fuzzy < 1 ? term.length * opts.fuzzy : opts.fuzzy)
    : 1
  const tree = frozenTermIndex(frozen)
  const scratch = {}
  baselineFn = () => {
    let n = 0
    packedRadixVisitFuzzyRefs(tree, term, maxDistance, () => { n++ })
    return n
  }
  treatmentFn = () => {
    let n = 0
    packedRadixVisitFuzzyRefs(tree, term, maxDistance, () => { n++ }, scratch)
    return n
  }
  checksumMatch = baselineFn() === treatmentFn()
  meta = { term, maxDistance }
} else if (variant === 'noop-control') {
  const raw = executeRaw(frozen, q, opts)
  const finalize = () => finalizeRaw(frozen, raw, q, opts)
  baselineFn = finalize
  treatmentFn = finalize
  const a = checksumHits(baselineFn())
  const b = checksumHits(treatmentFn())
  checksumMatch = a.hash === b.hash && a.count === b.count
  meta = { rawSize: raw.size, a, b }
} else {
  console.error(`unknown variant ${variant}`)
  process.exit(2)
}

const baselineBatch = calibrateBatch(baselineFn, targetMs)
const treatmentBatch = calibrateBatch(treatmentFn, targetMs)
const batchSize = Math.max(1, Math.round(Math.sqrt(baselineBatch * treatmentBatch)))
let baseline
let treatment
if (measurementOrder === 'treatment-first') {
  treatment = timedBatch(treatmentFn, { warmup, iterations, batchSize })
  baseline = timedBatch(baselineFn, { warmup, iterations, batchSize })
} else {
  baseline = timedBatch(baselineFn, { warmup, iterations, batchSize })
  treatment = timedBatch(treatmentFn, { warmup, iterations, batchSize })
}

console.log(JSON.stringify({
  ok: true,
  runtime: isBun ? 'bun' : 'node',
  version: isBun ? Bun.version : process.version,
  caseKey,
  variant,
  measurementOrder,
  baseline,
  treatment,
  ratio: baseline.p50 > 0 ? Number((treatment.p50 / baseline.p50).toFixed(6)) : null,
  checksumMatch,
  meta,
}))
