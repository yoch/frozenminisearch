import { hrtime } from 'node:process'
import { DEFAULT_BENCH_WARMUP, median } from './benchStats.js'
import { refBelowSearchFloor } from './regressionPolicy.js'
import {
  SEARCH_BENCH_FAST_PROBE_MS,
  SEARCH_BENCH_ITERATIONS,
  SEARCH_BENCH_ITERATIONS_FAST,
} from './searchBenchProtocol.js'

const NS_PER_MS = 1e6

function benchWarmupCount (iterations) {
  const fromEnv = Number(process.env.BENCH_WARMUP)
  const configured = Number.isFinite(fromEnv) && fromEnv >= 0
    ? Math.floor(fromEnv)
    : DEFAULT_BENCH_WARMUP
  return Math.max(configured, iterations)
}

export function benchHrtimeNow () {
  return hrtime.bigint()
}

/** Elapsed milliseconds since `benchHrtimeNow()` tick. */
export function benchHrtimeElapsedMs (startNs) {
  return Number(hrtime.bigint() - startNs) / NS_PER_MS
}

/**
 * Timed iterations for one runner (`fn` invoked `batchSize` times per sample).
 * @param {() => void} fn
 */
export function benchTimedSamples (fn, iterations, batchSize, warmupCount) {
  const warmup = warmupCount ?? benchWarmupCount(iterations)
  for (let i = 0; i < warmup; i++) fn()

  const times = []
  for (let i = 0; i < iterations; i++) {
    const t0 = benchHrtimeNow()
    for (let b = 0; b < batchSize; b++) fn()
    times.push(benchHrtimeElapsedMs(t0) / batchSize)
  }

  times.sort((a, b) => a - b)
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    batchSize,
  }
}

/**
 * Paired samples: each iteration times mutable then frozen back-to-back.
 * @param {() => void} runMutable
 * @param {() => void} runFrozen
 */
export function benchPairedSearchSamples (runMutable, runFrozen, iterations, batchSize, warmupCount) {
  const warmup = warmupCount ?? benchWarmupCount(iterations)
  for (let i = 0; i < warmup; i++) {
    runMutable()
    runFrozen()
  }

  const mutableTimes = []
  const frozenTimes = []
  const ratios = []

  for (let i = 0; i < iterations; i++) {
    const t0 = benchHrtimeNow()
    for (let b = 0; b < batchSize; b++) runMutable()
    const mut = benchHrtimeElapsedMs(t0) / batchSize

    const t1 = benchHrtimeNow()
    for (let b = 0; b < batchSize; b++) runFrozen()
    const frz = benchHrtimeElapsedMs(t1) / batchSize

    mutableTimes.push(mut)
    frozenTimes.push(frz)
    if (mut > 0) ratios.push(frz / mut)
  }

  return {
    mutableP50: median(mutableTimes),
    mutableP95: percentile(mutableTimes, 0.95),
    frozenP50: median(frozenTimes),
    frozenP95: percentile(frozenTimes, 0.95),
    pairedRatioP50: ratios.length ? median(ratios) : null,
    batchSize,
  }
}

function percentile (sortedInput, p) {
  const times = [...sortedInput].sort((a, b) => a - b)
  return times[Math.floor(times.length * p)] ?? 0
}

/** Iteration count from calibration probe (20 default, 50 when probe &lt; 0.1 ms). */
export function searchIterationsForBatchEntry (entry) {
  const fromEnv = Number(process.env.SEARCH_ITERATIONS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)

  const probe = entry?.calibratedProbeP50Ms
  if (probe && typeof probe === 'object') {
    const p50 = Math.max(probe.mutable ?? 0, probe.frozen ?? 0)
    if (p50 > 0 && p50 < SEARCH_BENCH_FAST_PROBE_MS) {
      return SEARCH_BENCH_ITERATIONS_FAST
    }
  }
  return SEARCH_BENCH_ITERATIONS
}

/** Human-readable frozen vs mutable delta (µs under search floor, else %). */
export function formatFrozenVsMutableDelta (mutableP50, frozenP50) {
  if (mutableP50 == null || frozenP50 == null) return '—'
  const base = mutableP50
  if (refBelowSearchFloor(base)) {
    const deltaUs = Math.round((frozenP50 - mutableP50) * 1000)
    const sign = deltaUs > 0 ? '+' : ''
    return `${sign}${deltaUs} µs`
  }
  if (base === 0) return '—'
  const pct = ((frozenP50 - base) / base) * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

export function frozenVsMutablePct (mutableP50, frozenP50) {
  if (mutableP50 == null || frozenP50 == null || mutableP50 === 0) return null
  return Number((((frozenP50 - mutableP50) / mutableP50) * 100).toFixed(1))
}

/**
 * Single-index search timing (hrtime).
 * @param {object} index
 * @param {import('../src/searchTypes.ts').Query} query
 */
export function benchSearch (index, query, searchOptions, iterations, benchOptions) {
  const batchSize = benchOptions.batchSize
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error('benchSearch requires benchOptions.batchSize')
  }
  return benchTimedSamples(
    () => index.search(query, searchOptions),
    iterations,
    batchSize,
  )
}

/** Paired mutable/frozen `search()` timing (hrtime). */
export function benchSearchPaired (mutableIndex, frozenIndex, query, searchOptions, iterations, benchOptions) {
  const batchSize = benchOptions.batchSize
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error('benchSearchPaired requires benchOptions.batchSize')
  }
  return benchPairedSearchSamples(
    () => mutableIndex.search(query, searchOptions),
    () => frozenIndex.search(query, searchOptions),
    iterations,
    batchSize,
  )
}
