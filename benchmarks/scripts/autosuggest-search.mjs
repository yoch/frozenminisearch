/**
 * Isolated autoSuggest timing for FrozenMiniSearch.
 *
 * Measures:
 * - executeQuery(): raw query execution with merged autoSuggest options
 * - suggestFromRaw(): suggestion aggregation from one reusable raw result
 * - autoSuggest(): full public autoSuggest path
 *
 * This is CPU-only instrumentation. It does not sample heap or process memory.
 *
 * Run:
 *   npm run benchmark:autosuggest -- --runs=5 --warmup=20 --iterations=50
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

function withStoredFields(docs) {
  return docs.map((doc, i) => ({
    ...doc,
    title: `Doc ${i}`,
    category: i % 2 === 0 ? 'even' : 'odd',
  }))
}

function suggestFromRawLikeFrozen(rawResults) {
  let allScoresEqual = true
  let firstScore

  for (const { score, terms } of rawResults.values()) {
    const finalScore = score * (terms.length || 1)
    if (firstScore == null) {
      firstScore = finalScore
    } else if (finalScore !== firstScore) {
      allScoresEqual = false
      break
    }
  }

  if (allScoresEqual) {
    const suggestions = new Map()
    for (const { score, terms, match } of rawResults.values()) {
      addSuggestion(suggestions, score * (terms.length || 1), Object.keys(match))
    }
    return finalizeSuggestions(suggestions)
  }

  const hits = new Array(rawResults.size)
  let write = 0

  for (const { score, terms, match } of rawResults.values()) {
    hits[write++] = { score: score * (terms.length || 1), terms: Object.keys(match) }
  }

  if (hits.length > 1) {
    hits.sort((a, b) => b.score - a.score)
  }

  const suggestions = new Map()
  for (const { score, terms } of hits) {
    addSuggestion(suggestions, score, terms)
  }
  return finalizeSuggestions(suggestions)
}

function addSuggestion(suggestions, score, terms) {
  const phrase = terms.join(' ')
  const suggestion = suggestions.get(phrase)
  if (suggestion != null) {
    suggestion.score += score
    suggestion.count += 1
  } else {
    suggestions.set(phrase, { score, terms, count: 1 })
  }
}

function finalizeSuggestions(suggestions) {
  const results = []
  for (const [suggestion, { score, terms, count }] of suggestions) {
    results.push({ suggestion, terms, score: score / count })
  }
  results.sort((a, b) => b.score - a.score)
  return results
}

function caseSpecs() {
  const highFreq = highFrequencyTerms(10000)
  const giant = giantVocabulary(50000)

  return [
    {
      id: 'multi-default',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: 'alpha beta',
      autoSuggestOptions: {},
    },
    {
      id: 'last-term-prefix',
      docs: highFreq,
      options: { fields: ['txt'], storeFields: [] },
      query: 'alpha vari',
      autoSuggestOptions: {},
    },
    {
      id: 'many-results-stored',
      docs: withStoredFields(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha beta',
      autoSuggestOptions: {},
    },
    {
      id: 'fuzzy',
      docs: giant,
      options: { fields: ['txt'], storeFields: [] },
      query: 'uniqe100',
      autoSuggestOptions: { fuzzy: 0.2 },
    },
    {
      id: 'filter',
      docs: withStoredFields(highFreq),
      options: { fields: ['txt'], storeFields: ['title', 'category'] },
      query: 'alpha beta',
      autoSuggestOptions: { filter: result => result.category === 'even' },
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
  const merged = { ...index._options.autoSuggestOptions, ...spec.autoSuggestOptions }
  const runRows = []
  let rawResults = 0

  for (let r = 0; r < runs; r++) {
    const raw = index.executeQuery(spec.query, merged)
    rawResults = raw.size
    runRows.push({
      executeQuery: timed(
        () => index.executeQuery(spec.query, merged),
        warmup,
        iterations,
      ),
      suggestFromRaw: timed(
        () => suggestFromRawLikeFrozen(raw),
        warmup,
        iterations,
      ),
      autoSuggest: timed(
        () => index.autoSuggest(spec.query, spec.autoSuggestOptions),
        warmup,
        iterations,
      ),
    })
  }

  const summary = {}
  for (const key of ['executeQuery', 'suggestFromRaw', 'autoSuggest']) {
    summary[key] = {
      p50: Number(median(runRows.map(row => row[key].p50)).toFixed(4)),
      p95: Number(median(runRows.map(row => row[key].p95)).toFixed(4)),
    }
  }

  report.cases.push({
    id: spec.id,
    documents: spec.docs.length,
    rawResults,
    usesFilter: spec.autoSuggestOptions.filter != null,
    summary,
  })
}

console.log(JSON.stringify(report, null, 2))
