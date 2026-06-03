import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function findRepoRoot () {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))]
  for (const start of starts) {
    let dir = start
    for (;;) {
      if (existsSync(join(dir, 'package.json'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

const REPO_ROOT = findRepoRoot()

export const gc = () => { if (global.gc) global.gc() }

export const heapBytes = () => process.memoryUsage().heapUsed

export function memorySnapshot () {
  const u = process.memoryUsage()
  return {
    heapUsed: u.heapUsed,
    external: u.external,
    arrayBuffers: u.arrayBuffers,
    rss: u.rss
  }
}

export function mb (bytes) {
  return bytes / 1024 / 1024
}

export function mbRound (bytes, digits = 3) {
  return Number(mb(bytes).toFixed(digits))
}

/** Percent change from base to value (negative = improvement when lower is better). */
export function pctDelta (base, value) {
  if (base === 0) return null
  return ((value - base) / base) * 100
}

export function pctDeltaRound (base, value, digits = 1) {
  const d = pctDelta(base, value)
  return d == null ? null : Number(d.toFixed(digits))
}

export function measureHeap (fn) {
  gc()
  const before = memorySnapshot()
  const value = fn()
  gc()
  const after = memorySnapshot()
  const delta = (key) => Math.max(0, after[key] - before[key])
  const heapBytesDelta = delta('heapUsed')
  const externalBytes = delta('external')
  const arrayBuffersBytes = delta('arrayBuffers')
  const rssBytes = delta('rss')
  return {
    value,
    heapMb: mbRound(heapBytesDelta),
    heapBytes: heapBytesDelta,
    externalMb: mbRound(externalBytes),
    externalBytes,
    arrayBuffersMb: mbRound(arrayBuffersBytes),
    arrayBuffersBytes,
    rssMb: mbRound(rssBytes),
    rssBytes,
    totalResidentApproxMb: mbRound(heapBytesDelta + externalBytes),
    totalResidentApproxBytes: heapBytesDelta + externalBytes
  }
}

export function medianOf (values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Median of numeric samples; 0 when empty (timing aggregates). */
export function median (values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

export function medianTimed (fn, iters) {
  const samples = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

export { mulberry32 } from '../testSupport/mulberry32.js'

export function medianMeasureHeap (fn, runs = 1) {
  if (runs <= 1) return measureHeap(fn)
  const samples = []
  let lastValue
  for (let i = 0; i < runs; i++) {
    const sample = measureHeap(fn)
    lastValue = sample.value
    samples.push(sample)
  }
  const pick = (key) => medianOf(samples.map((s) => s[key]))
  return {
    value: lastValue,
    heapMb: mbRound(pick('heapBytes')),
    heapBytes: pick('heapBytes'),
    externalMb: mbRound(pick('externalBytes')),
    externalBytes: pick('externalBytes'),
    arrayBuffersMb: mbRound(pick('arrayBuffersBytes')),
    arrayBuffersBytes: pick('arrayBuffersBytes'),
    rssMb: mbRound(pick('rssBytes')),
    rssBytes: pick('rssBytes'),
    totalResidentApproxMb: mbRound(pick('totalResidentApproxBytes')),
    totalResidentApproxBytes: pick('totalResidentApproxBytes')
  }
}

/** Routine defaults: median of 3 scenario runs, 25 timed searches, 100 warmup each. */
export const DEFAULT_BENCHMARK_RUNS = 3
export const DEFAULT_SEARCH_ITERATIONS = 25
/** Warmup searches before timing (JIT + per-instance posting view cache on frozen indexes). */
export const DEFAULT_BENCH_WARMUP = 100
/** Max searches per clock read (fixed batches are calibrated in searchBenchBatches.json). */
export const DEFAULT_BENCH_BATCH = 32

export function defaultBenchmarkRuns () {
  const fromEnv = Number(process.env.RUNS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return DEFAULT_BENCHMARK_RUNS
}

export function defaultSearchIterations () {
  const fromEnv = Number(process.env.SEARCH_ITERATIONS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  return DEFAULT_SEARCH_ITERATIONS
}

export function defaultBenchWarmup () {
  const fromEnv = Number(process.env.BENCH_WARMUP)
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.floor(fromEnv)
  return DEFAULT_BENCH_WARMUP
}

export function parseRunsArg (args = process.argv) {
  let runs = defaultBenchmarkRuns()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--runs') {
      const next = Number(args[i + 1])
      if (Number.isFinite(next) && next > 0) runs = Math.floor(next)
    } else if (arg.startsWith('--runs=')) {
      const next = Number(arg.split('=')[1])
      if (Number.isFinite(next) && next > 0) runs = Math.floor(next)
    }
  }
  return runs
}

export function parseSearchIterationsArg (args = process.argv) {
  let iterations = defaultSearchIterations()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--iterations') {
      const next = Number(args[i + 1])
      if (Number.isFinite(next) && next > 0) iterations = Math.floor(next)
    } else if (arg.startsWith('--iterations=')) {
      const next = Number(arg.split('=')[1])
      if (Number.isFinite(next) && next > 0) iterations = Math.floor(next)
    }
  }
  return iterations
}

export function parseBenchProfile (args = process.argv) {
  const env = process.env.BENCH_SEARCH_ONLY
  if (env === '1' || env === 'true' || env === 'yes') return 'search'
  if (env === '0' || env === 'false') return 'full'
  if (args.includes('--search-only')) return 'search'
  return 'full'
}

export function parseBenchmarkArgs (args = process.argv) {
  return {
    runs: parseRunsArg(args),
    searchIterations: parseSearchIterationsArg(args),
    benchProfile: parseBenchProfile(args),
  }
}

export function loadBenchmarkPayload (path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function argValue (flag, args = process.argv) {
  const eq = args.find((a) => a.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const i = args.indexOf(flag)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return null
}

/**
 * @param {object} [benchOptions]
 * @param {number} benchOptions.batchSize — fixed batch from searchBenchBatches.json (required)
 */
export function benchSearch (
  index,
  query,
  searchOptions = {},
  iterations = defaultSearchIterations(),
  benchOptions = {},
) {
  const batchSize = benchOptions.batchSize
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error(
      'benchSearch requires benchOptions.batchSize (see benchmarks/searchBenchBatches.json)',
    )
  }

  const runSearch = () => index.search(query, searchOptions)

  const warmupCount = Math.max(defaultBenchWarmup(), iterations)
  for (let i = 0; i < warmupCount; i++) runSearch()

  const times = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    for (let b = 0; b < batchSize; b++) runSearch()
    times.push((performance.now() - t0) / batchSize)
  }

  times.sort((a, b) => a - b)
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    batchSize,
  }
}

export function timedMs (fn) {
  const t0 = performance.now()
  const result = fn()
  return { result, ms: performance.now() - t0 }
}

function gitCommand (args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', cwd: REPO_ROOT }).trim()
  } catch {
    return null
  }
}

/** Modified tracked files only (untracked files ignored). */
export function trackedTreePorcelain () {
  return gitCommand('status --porcelain --untracked-files=no') ?? ''
}

export function isTrackedTreeClean () {
  return trackedTreePorcelain() === ''
}

/**
 * Refuse baseline capture when tracked files differ from HEAD.
 * @param {{ force?: boolean, context?: string }} [options]
 */
export function assertCleanTrackedTree (options = {}) {
  const { force = false, context = 'baseline' } = options
  if (force) return
  const dirty = trackedTreePorcelain()
  if (!dirty) return
  console.error(`Refus : l’arborescence suivie n’est pas propre (${context}).`)
  console.error('Modifications sur fichiers suivis :')
  for (const line of dirty.split('\n')) {
    if (line) console.error(`  ${line}`)
  }
  console.error('\nCommitez ou restaurez ces fichiers, puis relancez.')
  console.error('Pour forcer malgré tout : ajoutez --force (baseline non reproductible au commit HEAD).')
  process.exit(1)
}

/** Git fields stored with a golden baseline (commit = état du code mesuré). */
export function enrichGitForBaseline (git) {
  const commit = git?.commit ?? gitCommand('rev-parse HEAD')
  return {
    ...git,
    commit,
    commitShort: git?.commitShort ?? gitCommand('rev-parse --short HEAD'),
    branch: git?.branch ?? gitCommand('rev-parse --abbrev-ref HEAD'),
    dirty: false,
    commitDate: gitCommand('log -1 --format=%cI'),
    subject: gitCommand('log -1 --format=%s'),
    parentCommit: gitCommand('rev-parse HEAD^'),
  }
}

export const PACKED_RADIX_HISTORY_PATH = join(REPO_ROOT, 'benchmarks/packed-radix-history.jsonl')

/** Compact row for packed-radix-history.jsonl. */
export function packedRadixHistoryEntry (payload) {
  const corpora = {}
  for (const [id, row] of Object.entries(payload.corpora ?? {})) {
    const summary = {
      structuredBytes: row.bytes?.totalStructuredBytes,
      packedByteLength: row.bytes?.packedByteLength,
      edgeCount: row.edgeCount,
      runtimeApproxBytes: row.runtime?.totalResidentApproxBytes,
    }
    if (row.timings?.['get(hit)']?.hz != null) {
      summary.getHitHz = Math.round(row.timings['get(hit)'].hz)
      summary.prefixShortHz = Math.round(row.timings['prefix(short)']?.hz ?? 0)
    }
    corpora[id] = summary
  }
  return {
    protocolVersion: 1,
    recordKind: payload.metadata?.recordKind ?? 'clean-commit',
    capturedAt: payload.metadata?.capturedAt,
    packageVersion: payload.metadata?.packageVersion,
    git: payload.metadata?.git,
    baselineCommit: payload.metadata?.baselineCommit ?? payload.metadata?.git?.commit,
    suiteFingerprint: Object.keys(corpora),
    corpora,
  }
}

/**
 * Append one packed-radix snapshot (clean tree required unless force).
 * @returns {'appended' | 'skipped-duplicate'}
 */
export function appendPackedRadixHistory (payload, options = {}) {
  const {
    historyPath = PACKED_RADIX_HISTORY_PATH,
    force = false,
  } = options
  const entry = packedRadixHistoryEntry(payload)
  const headSha = entry.baselineCommit
  if (!headSha) {
    console.warn('appendPackedRadixHistory: pas de commit, historique non écrit')
    return 'skipped-duplicate'
  }

  if (existsSync(historyPath) && !force) {
    for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e.baselineCommit === headSha || e.git?.commit === headSha) {
          console.log(`Historique : déjà enregistré pour ${e.git?.commitShort ?? headSha.slice(0, 7)}`)
          return 'skipped-duplicate'
        }
      } catch { /* ignore */ }
    }
  }

  if (force && existsSync(historyPath)) {
    const kept = readFileSync(historyPath, 'utf8').split('\n').filter((line) => {
      if (!line.trim()) return false
      try {
        const e = JSON.parse(line)
        return e.baselineCommit !== headSha && e.git?.commit !== headSha
      } catch {
        return true
      }
    })
    writeFileSync(historyPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
  }

  appendFileSync(historyPath, `${JSON.stringify(entry)}\n`)
  return 'appended'
}

export function collectRunMetadata () {
  let version = null
  try {
    version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
  } catch { /* ignore */ }

  const trackedDirty = trackedTreePorcelain() !== ''
  const allDirty = gitCommand('status --porcelain') !== ''

  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    packageVersion: version,
    gcExposed: typeof global.gc === 'function',
    git: {
      commit: gitCommand('rev-parse HEAD'),
      commitShort: gitCommand('rev-parse --short HEAD'),
      branch: gitCommand('rev-parse --abbrev-ref HEAD'),
      dirty: allDirty,
      trackedDirty,
    }
  }
}

