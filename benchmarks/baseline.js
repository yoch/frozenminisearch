/**
 * @deprecated Use benchmarks/compare.js — yarn benchmark:compare
 * Quick single-run snapshot (kept for compatibility).
 */
import MiniSearch, { FrozenMiniSearch } from '../dist/es/index.js'
import { loadDivinaLines } from './loadDivinaLines.js'

const lines = loadDivinaLines()

const heapMb = () => {
  if (global.gc) global.gc()
  const { heapUsed, rss } = process.memoryUsage()
  return { heapUsedMb: (heapUsed / 1024 / 1024).toFixed(2), rssMb: (rss / 1024 / 1024).toFixed(2) }
}

const timed = (label, fn) => {
  const start = performance.now()
  const result = fn()
  const ms = (performance.now() - start).toFixed(2)
  console.log(`  ${label}: ${ms} ms`)
  return result
}

const percentile = (sorted, p) => {
  const i = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, i)]
}

const benchSearch = (miniSearch, label, query, options = {}) => {
  const times = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    miniSearch.search(query, options)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(`  ${label}: p50=${percentile(times, 50).toFixed(3)}ms p95=${percentile(times, 95).toFixed(3)}ms`)
}

const options = { fields: ['txt'], storeFields: ['txt'] }

console.log('=== MiniSearch baseline ===\n')
console.log(`Corpus: ${lines.length} documents\n`)

const before = heapMb()
const miniSearch = timed('new MiniSearch', () => new MiniSearch(options))
timed('addAll', () => miniSearch.addAll(lines))
const afterIndex = heapMb()
console.log(`  heap after index: ${afterIndex.heapUsedMb} MB (delta from gc baseline ${before.heapUsedMb} MB)`)
console.log(`  rss: ${afterIndex.rssMb} MB`)
console.log(`  terms: ${miniSearch.termCount}, documents: ${miniSearch.documentCount}\n`)

console.log('Search (50 iterations each):')
benchSearch(miniSearch, 'exact "inferno"', 'inferno')
benchSearch(miniSearch, 'OR combine', 'inferno paradiso', { combineWith: 'OR' })
benchSearch(miniSearch, 'AND combine', 'inferno paradiso', { combineWith: 'AND' })
benchSearch(miniSearch, 'prefix', 'infe', { prefix: true })
benchSearch(miniSearch, 'fuzzy', 'infern', { fuzzy: 0.2 })
benchSearch(miniSearch, 'wildcard', MiniSearch.wildcard)

console.log('\nSerialization:')
const json = timed('JSON.stringify (via toJSON)', () => JSON.stringify(miniSearch))
console.log(`  serialized size: ${(json.length / 1024 / 1024).toFixed(2)} MB`)
timed('loadJSON', () => {
  MiniSearch.loadJSON(json, options)
})

if (typeof miniSearch.freeze === 'function') {
  console.log('\nFrozen (if available):')
  const frozen = timed('freeze', () => miniSearch.freeze())
  const afterFreeze = heapMb()
  console.log(`  heap after freeze: ${afterFreeze.heapUsedMb} MB`)
  benchSearch(frozen, 'frozen exact', 'inferno')
  if (typeof frozen.saveBinary === 'function') {
    const buf = timed('saveBinary', () => frozen.saveBinary())
    console.log(`  binary size: ${(buf.length / 1024 / 1024).toFixed(2)} MB`)
    timed('loadBinary', () => FrozenMiniSearch.loadBinary(buf, options))
  }
}

console.log('\nDone.')
