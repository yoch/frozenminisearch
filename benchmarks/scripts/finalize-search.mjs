/**
 * Isolated finalize/search timing for FrozenMiniSearch, including bounded (`limit`) search.
 *
 * Measures, per case and limit:
 * - executeQuery(): raw query execution
 * - finalize(): public result materialization from one reusable raw result
 * - fullThenSlice(): unbounded public search followed by `.slice(0, limit)`
 * - search(): full public search path with the limit
 *
 * Every row is checked against the unbounded search sliced to the limit. This is
 * CPU-only instrumentation unless `--memory` is passed (retained returned results
 * after GC, averaged over batches of 20 searches).
 *
 * Run:
 *   pnpm benchmark:finalize RUNS=5 BENCH_WARMUP=20 SEARCH_ITERATIONS=50
 *   pnpm benchmark:finalize FINALIZE_BENCH_ARGS='--corpus=limit --cases=exact,filter-half --limits=1,20,near'
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import FrozenMiniSearch from '../../src/FrozenMiniSearch.ts'
import { finalizeSearchResults } from '../../src/scoring.ts'
import { executeRaw, finalizeRaw } from '../harness/frozenSourceInternals.ts'
import { giantVocabulary, highFrequencyTerms } from '../benchmarkScenarios.js'
import { medianMeasureHeap } from '../benchmarkUtils.js'
import { argValue, boolArg, intArg, listArg, median, timed } from './cpuBenchUtils.mjs'

const corpora = ['finalize', 'limit', 'bdpm-specialites']
const corpus = argValue('--corpus') ?? 'finalize'
assert.ok(corpora.includes(corpus), `Unknown corpus ${corpus}; expected one of ${corpora.join(', ')}`)
const documents = intArg('documents', 10000)
const runs = intArg('runs', 5)
const warmup = intArg('warmup', 20, { min: 0 })
const iterations = intArg('iterations', 50)
const measureMemory = boolArg('memory')
if (measureMemory) assert.equal(typeof globalThis.gc, 'function', '--memory requires --expose-gc')

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

/** Finalization cost by stored-field layout, filter and result count; one index per case. */
function finalizeCases() {
  const highFreq = highFrequencyTerms(10000)
  const giant = giantVocabulary(50000)
  const spec = (id, docs, storeFields, query, searchOptions = {}) => ({
    id,
    query,
    searchOptions,
    build: () => FrozenMiniSearch.fromDocuments(docs, { fields: ['txt'], storeFields }),
  })
  return [
    spec('many-results-no-stored', highFreq, [], 'alpha'),
    spec('many-results-single-stored', withSingleStored(highFreq), ['category'], 'alpha'),
    spec('many-results-multi-stored', withMultiStored(highFreq), ['title', 'category'], 'alpha'),
    spec('many-results-filter', withMultiStored(highFreq), ['title', 'category'], 'alpha', {
      filter: result => result.category === 'even',
    }),
    spec('wildcard-no-stored', highFreq, [], FrozenMiniSearch.wildcard),
    spec('prefix-large', giant, [], 'unique1', { prefix: true }),
  ]
}

/** Bounded-search query shapes over one synthetic index with tied and varied scores. */
function limitCases() {
  const docs = Array.from({ length: documents }, (_, i) => ({
    id: i,
    text: `${'alpha '.repeat(1 + i % 11)}${'beta '.repeat(i % 7)}unique${i} ${i % 100 === 0 ? 'rare' : ''}`,
    equal: 'common',
    bucket: i % 100,
    label: `Document ${i}`,
  }))
  let index
  const build = () => (index ??= FrozenMiniSearch.fromDocuments(docs, { fields: ['text', 'equal'], storeFields: ['bucket', 'label'] }))
  // Ids are 0..n-1, so raw doc ids index `docs` directly for materialization counting.
  const storedFields = docId => ({ bucket: docs[docId].bucket, label: docs[docId].label })
  return [
    ['exact', 'alpha', {}],
    ['equal-scores', 'common', {}],
    ['dense-OR', 'alpha beta', {}],
    ['selective-AND', 'alpha rare', { combineWith: 'AND' }],
    ['AND_NOT', 'alpha rare', { combineWith: 'AND_NOT' }],
    ['nested', { combineWith: 'AND', queries: ['alpha', { queries: ['beta', 'rare'] }] }, {}],
    ['prefix', 'uni', { prefix: true }],
    ['fuzzy', 'alhpa', { fuzzy: 2 }],
    ['wildcard', FrozenMiniSearch.wildcard, {}],
    ['wildcard-filter', FrozenMiniSearch.wildcard, { filter: r => r.bucket === 0 }],
    ['wildcard-boost', FrozenMiniSearch.wildcard, { boostDocument: id => 1 + id % 13 }],
    ['filter-all', 'alpha', { filter: () => true }],
    ['filter-half', 'alpha', { filter: r => r.bucket % 2 === 0 }],
    ['filter-one-percent', 'alpha', { filter: r => r.bucket === 0 }],
    ['filter-none', 'alpha', { filter: r => String(r.id) === 'missing-id' }],
  ].map(([id, query, searchOptions]) => ({ id, query, searchOptions, build, storedFields }))
}

/** Bounded search on the checked-in BDPM fixture; filters use stable id buckets. */
function bdpmCases(snapshot) {
  let index
  const build = () => (index ??= FrozenMiniSearch.loadBinarySync(snapshot))
  const bucket = result => {
    let hash = 0
    for (const char of String(result.id)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
    return (hash >>> 0) % 100
  }
  return [
    ['exact', 'comprime', {}],
    ['dense-OR', 'comprime gelule', {}],
    ['selective-AND', 'comprime pellicule', { combineWith: 'AND' }],
    ['AND_NOT', 'comprime pellicule', { combineWith: 'AND_NOT' }],
    ['prefix', 'amox', { prefix: true }],
    ['fuzzy', 'dolipran', { fuzzy: 1 }],
    ['wildcard', FrozenMiniSearch.wildcard, {}],
    ['wildcard-filter', FrozenMiniSearch.wildcard, { filter: r => bucket(r) === 0 }],
    ['filter-all', 'comprime', { filter: () => true }],
    ['filter-half', 'comprime', { filter: r => bucket(r) % 2 === 0 }],
    ['filter-one-percent', 'comprime', { filter: r => bucket(r) === 0 }],
    ['filter-none', 'comprime', { filter: r => String(r.id) === 'missing-id' }],
  ].map(([id, query, searchOptions]) => ({ id, query, searchOptions, build }))
}

const snapshot = corpus === 'bdpm-specialites'
  ? readFileSync(new URL('../fixtures/medicaments-indexes/bdpm_specialites.msbin', import.meta.url))
  : undefined
const specs = corpus === 'finalize' ? finalizeCases() : corpus === 'limit' ? limitCases() : bdpmCases(snapshot)
const selectedCases = listArg('cases', specs.map(spec => spec.id))
for (const id of selectedCases) assert.ok(specs.some(spec => spec.id === id), `Unknown case ${id}`)
const selectedLimits = listArg('limits', corpus === 'finalize' ? ['Infinity'] : ['0', '1', '10', '20', '100', 'near', 'Infinity'])

const report = {
  capturedAt: new Date().toISOString(),
  node: process.version,
  architecture: process.arch,
  cpu: cpus()[0]?.model,
  corpus,
  snapshotSha256: snapshot == null ? undefined : createHash('sha256').update(snapshot).digest('hex'),
  runs,
  warmup,
  iterations,
  cases: [],
}

for (const spec of specs) {
  if (!selectedCases.includes(spec.id)) continue
  const { id, query, searchOptions: options, storedFields } = spec
  const index = spec.build()
  const raw = executeRaw(index, query, options)
  assert.ok(raw.size > 0, `Empty query scenario: ${id}`)
  const full = index.search(query, options)
  for (const label of selectedLimits) {
    const limit = label === 'near' ? Math.max(0, raw.size - 1) : Number(label)
    assert.ok(limit === Infinity || (Number.isInteger(limit) && limit >= 0), `Invalid limit ${label}`)
    const limitedOptions = { ...options, limit }
    assert.deepEqual(index.search(query, limitedOptions), full.slice(0, limit))
    let materializations = storedFields == null ? null : 0
    let filterCalls = 0
    const countingFilter = options.filter == null ? undefined : result => { filterCalls++; return options.filter(result) }
    const audit = storedFields == null
      ? finalizeRaw(index, raw, query, { ...limitedOptions, filter: countingFilter })
      : finalizeSearchResults({
        rawResults: raw,
        limit: limit === Infinity ? undefined : limit,
        skipSort: query === FrozenMiniSearch.wildcard && options.boostDocument == null,
        getExternalId: docId => { materializations++; return docId },
        getStoredFields: storedFields,
        filter: countingFilter,
      })
    assert.deepEqual(audit, full.slice(0, limit))
    const samples = { executeQuery: [], finalize: [], fullThenSlice: [], search: [] }
    const jobs = {
      executeQuery: () => executeRaw(index, query, limitedOptions),
      finalize: () => finalizeRaw(index, raw, query, limitedOptions),
      fullThenSlice: () => index.search(query, options).slice(0, limit),
      search: () => index.search(query, limitedOptions),
    }
    // Rotate mode order to reduce systematic warmup/order bias.
    const modes = Object.keys(jobs)
    for (let run = 0; run < runs; run++) {
      for (let offset = 0; offset < modes.length; offset++) {
        const mode = modes[(offset + run) % modes.length]
        samples[mode].push(timed(jobs[mode], warmup, iterations))
      }
    }
    const summary = Object.fromEntries(modes.map(mode => [mode, {
      p50: Number(median(samples[mode].map(s => s.p50)).toFixed(4)),
      p95: Number(median(samples[mode].map(s => s.p95)).toFixed(4)),
    }]))
    const retainedResultMemory = measureMemory ? Object.fromEntries(['fullThenSlice', 'search'].map(mode => {
      // Retain a batch to make a small returned array measurable above GC noise.
      const sample = medianMeasureHeap(() => Array.from({ length: 20 }, jobs[mode]), 3)
      return [mode, { heapBytesPerSearch: sample.heapBytes / 20, externalBytesPerSearch: sample.externalBytes / 20 }]
    })) : undefined
    report.cases.push({
      id,
      limit: label,
      documents: index.documentCount,
      rawResults: raw.size,
      returned: audit.length,
      materializations,
      filterCalls,
      summary,
      retainedResultMemory,
    })
  }
}

const json = `${JSON.stringify(report, null, 2)}\n`
const output = argValue('--output')
if (output == null) process.stdout.write(json)
else writeFileSync(output, json)
