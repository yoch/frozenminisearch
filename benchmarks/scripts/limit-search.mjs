/** Reproducible limit audit: query CPU, finalization, full+slice, and public search. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import FrozenMiniSearch from '../../src/FrozenMiniSearch.ts'
import { finalizeSearchResults } from '../../src/scoring.ts'
import { executeRaw, finalizeRaw } from '../harness/frozenSourceInternals.ts'
import { medianMeasureHeap } from '../benchmarkUtils.js'
import { argValue, boolArg, intArg, listArg, median, timed } from './cpuBenchUtils.mjs'

const documents = intArg('documents', 10000)
const runs = intArg('runs', 5)
const warmup = intArg('warmup', 20, { min: 0 })
const iterations = intArg('iterations', 30)
const corpus = argValue('--corpus') ?? 'synthetic'
assert.ok(['synthetic', 'bdpm-specialites'].includes(corpus), `Unknown corpus ${corpus}`)
const measureMemory = boolArg('memory')
if (measureMemory) assert.equal(typeof globalThis.gc, 'function', '--memory requires --expose-gc')
const docs = Array.from({ length: documents }, (_, i) => ({
  id: i,
  text: `${'alpha '.repeat(1 + i % 11)}${'beta '.repeat(i % 7)}unique${i} ${i % 100 === 0 ? 'rare' : ''}`,
  equal: 'common',
  bucket: i % 100,
  label: `Document ${i}`,
}))
const snapshot = corpus === 'bdpm-specialites'
  ? readFileSync(new URL('../fixtures/medicaments-indexes/bdpm_specialites.msbin', import.meta.url))
  : undefined
const index = snapshot == null
  ? FrozenMiniSearch.fromDocuments(docs, { fields: ['text', 'equal'], storeFields: ['bucket', 'label'] })
  : FrozenMiniSearch.loadBinarySync(snapshot)
const bucket = result => {
  if (snapshot == null) return result.bucket
  let hash = 0
  for (const char of String(result.id)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
  return (hash >>> 0) % 100
}
const specs = snapshot == null ? [
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
] : [
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
]
const selectedCases = listArg('cases', specs.map(([id]) => id))
for (const id of selectedCases) assert.ok(specs.some(([name]) => name === id), `Unknown case ${id}`)
const selectedLimits = listArg('limits', ['0', '1', '10', '20', '100', 'near', 'Infinity'])
const report = {
  capturedAt: new Date().toISOString(),
  node: process.version,
  architecture: process.arch,
  cpu: cpus()[0]?.model,
  corpus,
  snapshotSha256: snapshot == null ? undefined : createHash('sha256').update(snapshot).digest('hex'),
  documents: index.documentCount, runs, warmup, iterations,
  cases: [],
}

for (const [id, query, options] of specs) {
  if (!selectedCases.includes(id)) continue
  const raw = executeRaw(index, query, options)
  assert.ok(raw.size > 0, `Empty query scenario: ${id}`)
  const full = index.search(query, options)
  for (const label of selectedLimits) {
    const limit = label === 'near' ? Math.max(0, raw.size - 1) : Number(label)
    assert.ok(limit === Infinity || (Number.isInteger(limit) && limit >= 0), `Invalid limit ${label}`)
    const limitedOptions = { ...options, limit }
    assert.deepEqual(index.search(query, limitedOptions), full.slice(0, limit))
    let materializations = snapshot == null ? 0 : null
    let filterCalls = 0
    const audit = snapshot == null ? finalizeSearchResults({
      rawResults: raw,
      limit: limit === Infinity ? undefined : limit,
      skipSort: query === FrozenMiniSearch.wildcard && options.boostDocument == null,
      getExternalId: docId => { materializations++; return docId },
      getStoredFields: docId => ({ bucket: docs[docId].bucket, label: docs[docId].label }),
      filter: options.filter == null ? undefined : result => { filterCalls++; return options.filter(result) },
    }) : finalizeRaw(index, raw, query, {
      ...limitedOptions,
      filter: options.filter == null ? undefined : result => { filterCalls++; return options.filter(result) },
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
      p50: median(samples[mode].map(s => s.p50)),
      p95: median(samples[mode].map(s => s.p95)),
    }]))
    const retainedResultMemory = measureMemory ? Object.fromEntries(['fullThenSlice', 'search'].map(mode => {
      // Retain a batch to make a small returned array measurable above GC noise.
      const sample = medianMeasureHeap(() => Array.from({ length: 20 }, jobs[mode]), 3)
      return [mode, { heapBytesPerSearch: sample.heapBytes / 20, externalBytesPerSearch: sample.externalBytes / 20 }]
    })) : undefined
    report.cases.push({ id, limit: label, rawResults: raw.size, returned: audit.length, materializations, filterCalls, summary, retainedResultMemory })
  }
}
const json = `${JSON.stringify(report, null, 2)}\n`
const output = argValue('--output')
if (output == null) process.stdout.write(json)
else writeFileSync(output, json)
