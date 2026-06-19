/**
 * Isolated finalize/search timing for FrozenMiniSearch.
 *
 * Measures:
 * - executeQuery(): raw query execution
 * - finalize(): public result materialization from one reusable raw result
 * - search(): full public search path
 *
 * This is CPU-only instrumentation. It does not sample heap or process memory.
 *
 * Run:
 *   npm run benchmark:finalize -- --runs=5 --warmup=20 --iterations=50
 */
import { performance } from 'node:perf_hooks'
import FrozenMiniSearch from '../../dist/es/index.js'
import { giantVocabulary, highFrequencyTerms } from '../benchmarkScenarios.js'

function argValue(name) {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === `--${name}`) return process.argv[i + 1]
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

function intArg(name, fallback) {
  const raw = argValue(name)
  const value = raw == null ? NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function p95(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]
}

function timed(fn, warmup, iterations) {
  let sink = 0
  for (let i = 0; i < warmup; i++) {
    const value = fn()
    sink += value?.size ?? value?.length ?? 0
  }
  if (typeof globalThis.gc === 'function') globalThis.gc()

  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    const value = fn()
    samples.push(performance.now() - t0)
    sink += value?.size ?? value?.length ?? 0
  }
  return { p50: median(samples), p95: p95(samples), sink }
}

function withSingleStored(docs) {
  return docs.map((doc, i) => ({
    ...doc,
    category: i % 2 === 0 ? 'even' : undefined,
  }))
}

function withMultiStored(docs) {
  return docs.map((doc, i) => ({
    ...doc,
    title: `Doc ${i}`,
    category: i % 2 === 0 ? 'even' : 'odd',
  }))
}

function caseSpecs() {
  const highFreq = highFrequencyTerms(10000)
  const giant = giantVocabulary(50000)
  return [
    {
      id: 'many-results-no-stored',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: 'alpha',
      searchOptions: {},
    },
    {
      id: 'many-results-single-stored',
      docs: withSingleStored(highFreq),
      options: { fields: ['txt'], storeFields: ['category'] },
      query: 'alpha',
      searchOptions: {},
    },
    {
      id: 'many-results-multi-stored',
      docs: withMultiStored(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha',
      searchOptions: {},
    },
    {
      id: 'many-results-filter',
      docs: withMultiStored(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha',
      searchOptions: { filter: result => result.category === 'even' },
    },
    {
      id: 'wildcard-no-stored',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: FrozenMiniSearch.wildcard,
      searchOptions: {},
    },
    {
      id: 'prefix-large',
      docs: giant,
      options: { fields: ['txt'], storeFields: [] },
      query: 'unique1',
      searchOptions: { prefix: true },
    },
  ]
}

const runs = intArg('runs', 5)
const warmup = intArg('warmup', 20)
const iterations = intArg('iterations', 50)
const report = {
  capturedAt: new Date().toISOString(),
  runs,
  warmup,
  iterations,
  cases: [],
}

for (const spec of caseSpecs()) {
  const index = FrozenMiniSearch.fromDocuments(spec.docs, spec.options)
  const runRows = []
  let rawResults = 0

  for (let r = 0; r < runs; r++) {
    // Reuse one raw result per run to isolate finalize() without folding
    // executeQuery() cost into the timed section.
    const raw = index.executeQuery(spec.query, spec.searchOptions)
    rawResults = raw.size
    runRows.push({
      executeQuery: timed(
        () => index.executeQuery(spec.query, spec.searchOptions),
        warmup,
        iterations,
      ),
      finalize: timed(
        () => index.finalizeRawSearchResults(raw, spec.query, spec.searchOptions),
        warmup,
        iterations,
      ),
      search: timed(
        () => index.search(spec.query, spec.searchOptions),
        warmup,
        iterations,
      ),
    })
  }

  const summary = {}
  for (const key of ['executeQuery', 'finalize', 'search']) {
    summary[key] = {
      p50: Number(median(runRows.map(row => row[key].p50)).toFixed(4)),
      p95: Number(median(runRows.map(row => row[key].p95)).toFixed(4)),
    }
  }
  report.cases.push({
    id: spec.id,
    documents: spec.docs.length,
    rawResults,
    summary,
  })
}

console.log(JSON.stringify(report, null, 2))
