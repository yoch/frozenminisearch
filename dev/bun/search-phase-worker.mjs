#!/usr/bin/env node
/**
 * Isolated search-phase worker. One process = one case measurement.
 *
 *   node --expose-gc --import tsx dev/bun/search-phase-worker.mjs --case=divina-storeFields:fuzzy
 *   bun --no-install --expose-gc dev/bun/search-phase-worker.mjs --case=...
 *
 * --mode=baseline|phases|all
 * --warmup-curve  optional warmup curve
 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  executeRaw,
  executeRawWithRunOptions,
  finalizeRaw,
  frozenTermIndex,
} from '../../benchmarks/harness/frozenSourceInternals.ts'
import { caseByKey } from './search-cases.mjs'

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
    gcExposed: typeof globalThis.gc === 'function',
  }
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

function mad (xs, med) {
  return median(xs.map((x) => Math.abs(x - med)))
}

function p95 (xs) {
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.max(0, Math.ceil(a.length * 0.95) - 1)]
}

function calibrateBatch (fn, targetMs = 25, maxBatch = 4096) {
  const t0 = performance.now()
  fn()
  const one = Math.max(performance.now() - t0, 1e-6)
  let batch = Math.min(maxBatch, Math.max(1, Math.ceil(targetMs / one)))
  const t1 = performance.now()
  for (let i = 0; i < batch; i++) fn()
  const elapsed = Math.max(performance.now() - t1, 1e-6)
  batch = Math.min(maxBatch, Math.max(1, Math.round(batch * (targetMs / elapsed))))
  return batch
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
  return {
    p50: Number(med.toFixed(6)),
    p95: Number(p95(samples).toFixed(6)),
    mad: Number(mad(samples, med).toFixed(6)),
    batchSize,
    iterations,
    sink,
  }
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

function hashString (text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

function checksumHits (hits) {
  const strict = JSON.stringify(stableValue(hits))
  const tolerant = JSON.stringify(stableValue(hits, 5))
  const shape = JSON.stringify(stableValue(hits, null, '', true))
  return {
    count: hits.length,
    strictHash: hashString(strict),
    tolerantHash: hashString(tolerant),
    shapeHash: hashString(shape),
    topIds: hits.slice(0, 5).map(hit => hit.id),
  }
}

function primaryTerm (query, tokenize, processTerm) {
  const tokens = tokenize(String(query))
    .flatMap((t) => {
      const p = processTerm(t)
      return Array.isArray(p) ? p : [p]
    })
    .filter(Boolean)
  return tokens[0] ?? String(query)
}

function buildIndexes (caze) {
  if (caze.kind === 'medicaments') {
    const buf = readFileSync(caze.file)
    const frozen = FrozenMiniSearch.loadBinarySync(buf, {})
    return { frozen, mutable: null }
  }
  const mutable = new MiniSearch(caze.options)
  mutable.addAll(caze.corpus)
  const frozen = FrozenMiniSearch.fromDocuments(caze.corpus, caze.options)
  return { frozen, mutable }
}

const caseKey = argValue('case')
const mode = argValue('mode') || 'all'
const warmup = Number(argValue('warmup') || 30)
const iterations = Number(argValue('iterations') || 40)
const targetMs = Number(argValue('target-ms') || 25)
const implementationOrder = argValue('implementation-order') || 'frozen-first'

if (!caseKey) {
  console.error('missing --case=')
  process.exit(2)
}

const caze = caseByKey(caseKey)
if (!caze) {
  console.error(`unknown case ${caseKey}`)
  process.exit(2)
}

const info = runtimeInfo()
const { frozen, mutable } = buildIndexes(caze)
const q = caze.query
const opts = caze.opts

frozen.search(q, opts)
mutable?.search(q, opts)

const report = {
  ok: true,
  ...info,
  caseKey,
  scenarioId: caze.scenarioId,
  label: caze.label,
  kind: caze.kind,
  query: q,
  opts,
  mode,
  implementationOrder,
}

if (mode === 'baseline' || mode === 'all') {
  const implementations = {
    frozen: {
      fn: () => frozen.search(q, opts),
    },
  }
  if (mutable) {
    implementations.mutable = {
      fn: () => mutable.search(q, opts),
    }
  }
  const order = implementationOrder === 'mutable-first' && mutable
    ? ['mutable', 'frozen']
    : ['frozen', ...(mutable ? ['mutable'] : [])]
  for (const name of order) {
    const implementation = implementations[name]
    const batchSize = calibrateBatch(implementation.fn, targetMs)
    const timing = timedBatch(implementation.fn, {
      warmup,
      iterations,
      batchSize,
    })
    report[name] = {
      ...timing,
      checksum: checksumHits(implementation.fn()),
    }
  }
  if (mutable) {
    report.advantageQ = report.mutable.p50 > 0
      ? Number((report.frozen.p50 / report.mutable.p50).toFixed(6))
      : null
    report.frozenMutableParity = {
      count: report.frozen.checksum.count === report.mutable.checksum.count,
      shape: report.frozen.checksum.shapeHash === report.mutable.checksum.shapeHash,
      strict: report.frozen.checksum.strictHash === report.mutable.checksum.strictHash,
      tolerant: report.frozen.checksum.tolerantHash === report.mutable.checksum.tolerantHash,
    }
  }
}

if (mode === 'phases' || mode === 'all') {
  const tokenize = FrozenMiniSearch.getDefault('tokenize')
  const processTerm = FrozenMiniSearch.getDefault('processTerm')
  const term = primaryTerm(q, tokenize, processTerm)
  const termIndex = frozenTermIndex(frozen)

  const l0Fn = () => termIndex.get(term)
  const L0 = timedBatch(l0Fn, {
    warmup,
    iterations,
    batchSize: calibrateBatch(l0Fn, Math.min(targetMs, 10)),
  })

  const rawFn = () => executeRaw(frozen, q, opts)
  const execute = timedBatch(rawFn, {
    warmup,
    iterations,
    batchSize: calibrateBatch(rawFn, targetMs),
  })

  const gatedOffFn = () => executeRawWithRunOptions(frozen, q, opts, { disableGating: true })
  const gatingOff = timedBatch(gatedOffFn, {
    warmup,
    iterations,
    batchSize: calibrateBatch(gatedOffFn, targetMs),
  })

  const rawOnce = executeRaw(frozen, q, opts)
  const finalizeFn = () => finalizeRaw(frozen, rawOnce, q, opts)
  const finalize = timedBatch(finalizeFn, {
    warmup,
    iterations,
    batchSize: calibrateBatch(finalizeFn, Math.min(targetMs, 15)),
  })

  const searchFn = () => frozen.search(q, opts)
  const search = timedBatch(searchFn, {
    warmup,
    iterations,
    batchSize: calibrateBatch(searchFn, targetMs),
  })

  let termResolve = null
  if (opts.prefix) {
    const prefixFn = () => {
      let n = 0
      termIndex.visitPrefixRefs(term, () => { n++ })
      return n
    }
    termResolve = {
      kind: 'prefix',
      ...timedBatch(prefixFn, {
        warmup,
        iterations,
        batchSize: calibrateBatch(prefixFn, targetMs),
      }),
    }
  } else if (opts.fuzzy != null) {
    const maxDistance = typeof opts.fuzzy === 'number'
      ? Math.floor(opts.fuzzy < 1 ? term.length * opts.fuzzy : opts.fuzzy)
      : 1
    const fuzzyFn = () => {
      let n = 0
      termIndex.visitFuzzyRefs(term, maxDistance, () => { n++ })
      return n
    }
    termResolve = {
      kind: 'fuzzy',
      maxDistance,
      ...timedBatch(fuzzyFn, {
        warmup,
        iterations,
        batchSize: calibrateBatch(fuzzyFn, targetMs),
      }),
    }
  }

  report.phases = {
    term,
    L0,
    executeRaw: execute,
    gatingDisabled: gatingOff,
    gatingDeltaMs: Number((gatingOff.p50 - execute.p50).toFixed(6)),
    finalize,
    search,
    termResolve,
    rawResultCount: rawOnce.size,
  }
}

if (process.argv.includes('--warmup-curve')) {
  forceGc()
  const curve = []
  for (const n of [1, 10, 100, 1000]) {
    const t0 = performance.now()
    for (let i = 0; i < n; i++) frozen.search(q, opts)
    const total = performance.now() - t0
    curve.push({
      calls: n,
      totalMs: Number(total.toFixed(3)),
      perCallMs: Number((total / n).toFixed(6)),
    })
  }
  report.warmupCurve = curve
}

console.log(JSON.stringify(report))
