/**
 * Compare MiniSearch (mutable) vs FrozenMiniSearch in realistic scenarios.
 * Each measurement runs in isolation (GC between runs) so heap reflects one index only.
 *
 * Run: yarn benchmark:compare
 * Requires: yarn build && node --expose-gc
 */
import MiniSearch, { FrozenMiniSearch } from '../dist/es/index.js'
import { loadDivinaLines } from './loadDivinaLines.js'

const lines = loadDivinaLines()

const profiles = [
  {
    name: 'With storeFields (full documents in index)',
    options: { fields: ['txt'], storeFields: ['txt'] }
  },
  {
    name: 'Index only (no storeFields — isolates inverted-index RAM)',
    options: { fields: ['txt'], storeFields: [] }
  }
]

const gc = () => { if (global.gc) global.gc() }

const heapBytes = () => process.memoryUsage().heapUsed

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2)

const pct = (base, value) => {
  if (base === 0) return '—'
  const delta = ((value - base) / base) * 100
  const sign = delta <= 0 ? '' : '+'
  return `${sign}${delta.toFixed(1)}%`
}

/** Measure heap delta for a single index kept alive (fn must return the index). */
function measureHeap (label, fn) {
  gc()
  const before = heapBytes()
  const value = fn()
  gc()
  const after = heapBytes()
  const delta = Math.max(0, after - before)
  return { label, value, heapMb: parseFloat(mb(delta)), heapBytes: delta }
}

function benchSearch (index, query, searchOptions = {}, iterations = 80) {
  // warmup
  index.search(query, searchOptions)
  const times = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    index.search(query, searchOptions)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.floor(times.length * 0.95)]
  return { p50, p95 }
}

function timedMs (fn) {
  const t0 = performance.now()
  const result = fn()
  return { result, ms: performance.now() - t0 }
}

function printTable (rows) {
  const col = (s, w) => String(s).padEnd(w)
  const w = [28, 14, 14, 14, 12]
  console.log(col('Scenario', w[0]) + col('Heap (MB)', w[1]) + col('Disk (MB)', w[2]) + col('Load (ms)', w[3]) + col('vs mutable', w[4]))
  console.log('-'.repeat(w.reduce((a, b) => a + b, 0)))
  for (const r of rows) {
    console.log(
      col(r.label, w[0]) +
      col(r.heapMb ?? '—', w[1]) +
      col(r.diskMb ?? '—', w[2]) +
      col(r.loadMs != null ? r.loadMs.toFixed(1) : '—', w[3]) +
      col(r.vsMutable ?? '—', w[4])
    )
  }
}

console.log('=== MiniSearch vs FrozenMiniSearch (isolated measurements) ===\n')
console.log(`Corpus: ${lines.length} documents\n`)

if (!global.gc) {
  console.log('Tip: run with --expose-gc for accurate heap numbers.\n')
}

function runProfile ({ name, options }) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`Profile: ${name}`)
  console.log(`  fields: [${options.fields.join(', ')}], storeFields: [${(options.storeFields || []).join(', ') || '(none)'}]`)
  console.log('='.repeat(72))

  let json
  let binaryBuf
  let indexMs
  let freezeMs
  let jsonSerializeMs
  let binarySerializeMs

  {
    const ms = timedMs(() => {
      const m = new MiniSearch(options)
      m.addAll(lines)
      return m
    })
    indexMs = ms.ms
    const ser = timedMs(() => JSON.stringify(ms.result))
    json = ser.result
    jsonSerializeMs = ser.ms
    const fr = timedMs(() => ms.result.freeze())
    freezeMs = fr.ms
    const bin = timedMs(() => fr.result.saveBinary())
    binaryBuf = bin.result
    binarySerializeMs = bin.ms
  }

  const jsonMb = parseFloat(mb(json.length))
  const binaryMb = parseFloat(mb(binaryBuf.length))
  gc()

  const heapMutable = measureHeap('Mutable MiniSearch', () => {
    const ms = new MiniSearch(options)
    ms.addAll(lines)
    return ms
  })

  const heapFrozen = measureHeap('FrozenMiniSearch (freeze only)', () => {
    const ms = new MiniSearch(options)
    ms.addAll(lines)
    return ms.freeze()
  })

  const heapJsonLoaded = measureHeap('Reloaded via loadJSON', () => {
    return MiniSearch.loadJSON(json, options)
  })

  const heapBinaryLoaded = measureHeap('Reloaded via loadBinary', () => {
    return FrozenMiniSearch.loadBinary(binaryBuf, options)
  })

  gc()
  const loadJson = timedMs(() => MiniSearch.loadJSON(json, options))
  gc()
  const loadBinary = timedMs(() => FrozenMiniSearch.loadBinary(binaryBuf, options))
  gc()

  const queries = [
    { label: 'exact', q: 'inferno', opts: {} },
    { label: 'AND', q: 'inferno paradiso', opts: { combineWith: 'AND' } },
    { label: 'prefix', q: 'infe', opts: { prefix: true } },
    { label: 'fuzzy', q: 'infern', opts: { fuzzy: 0.2 } }
  ]

  function withIndex (factory, fn) {
    gc()
    let out
    {
      const index = factory()
      out = fn(index)
    }
    gc()
    return out
  }

  const searchRows = []
  for (const { label, q, opts } of queries) {
    const mutable = withIndex(() => {
      const ms = new MiniSearch(options)
      ms.addAll(lines)
      return ms
    }, (idx) => benchSearch(idx, q, opts))

    const frozen = withIndex(() => {
      const ms = new MiniSearch(options)
      ms.addAll(lines)
      return ms.freeze()
    }, (idx) => benchSearch(idx, q, opts))

    searchRows.push({ label, mutable, frozen })
  }

  console.log('\nIndexing:')
  console.log(`  addAll:         ${indexMs.toFixed(1)} ms`)
  console.log(`  freeze:         ${freezeMs.toFixed(1)} ms  (offline, once)`)
  console.log(`  JSON.stringify: ${jsonSerializeMs.toFixed(1)} ms`)
  console.log(`  saveBinary:     ${binarySerializeMs.toFixed(1)} ms`)

  const baseHeap = heapMutable.heapMb
  const summary = [
    { label: 'Mutable MiniSearch', heapMb: heapMutable.heapMb.toFixed(2), diskMb: jsonMb.toFixed(2), loadMs: loadJson.ms, vsMutable: 'baseline' },
    { label: 'FrozenMiniSearch', heapMb: heapFrozen.heapMb.toFixed(2), diskMb: binaryMb.toFixed(2), loadMs: null, vsMutable: pct(baseHeap, heapFrozen.heapMb) },
    { label: 'loadJSON → MiniSearch', heapMb: heapJsonLoaded.heapMb.toFixed(2), diskMb: jsonMb.toFixed(2), loadMs: loadJson.ms, vsMutable: pct(baseHeap, heapJsonLoaded.heapMb) },
    { label: 'loadBinary → Frozen', heapMb: heapBinaryLoaded.heapMb.toFixed(2), diskMb: binaryMb.toFixed(2), loadMs: loadBinary.ms, vsMutable: pct(baseHeap, heapBinaryLoaded.heapMb) }
  ]

  console.log('\nMemory & persistence (one index in RAM after GC):\n')
  printTable(summary)

  console.log('\nCold load:')
  console.log(`  loadJSON:   ${loadJson.ms.toFixed(1)} ms`)
  console.log(`  loadBinary: ${loadBinary.ms.toFixed(1)} ms  (${pct(loadJson.ms, loadBinary.ms)} vs loadJSON)`)

  console.log('\nSearch p50 / p95 (ms):\n')
  console.log('Query'.padEnd(12) + 'Mutable p50'.padEnd(14) + 'Frozen p50'.padEnd(14) + 'Δ p50'.padEnd(10) + 'Mutable p95'.padEnd(14) + 'Frozen p95')
  console.log('-'.repeat(68))
  for (const { label, mutable, frozen } of searchRows) {
    console.log(
      label.padEnd(12) +
      mutable.p50.toFixed(3).padEnd(14) +
      frozen.p50.toFixed(3).padEnd(14) +
      pct(mutable.p50, frozen.p50).padEnd(10) +
      mutable.p95.toFixed(3).padEnd(14) +
      frozen.p95.toFixed(3)
    )
  }

  const heapSaving = (1 - heapFrozen.heapMb / baseHeap) * 100
  const diskSaving = (1 - binaryMb / jsonMb) * 100
  const loadSaving = (1 - loadBinary.ms / loadJson.ms) * 100
  console.log('\nProfile summary:')
  console.log(`  RAM frozen vs mutable (isolated):  ${heapSaving.toFixed(1)}% smaller`)
  console.log(`  Disk binary vs JSON:               ${diskSaving.toFixed(1)}% smaller`)
  console.log(`  Cold load binary vs JSON:          ${loadSaving.toFixed(1)}% faster`)
  const avgP50Gain = searchRows.reduce((s, r) => s + (1 - r.frozen.p50 / r.mutable.p50), 0) / searchRows.length * 100
  console.log(`  Search p50 (avg across queries):   ${avgP50Gain.toFixed(1)}% faster on frozen`)
}

for (const profile of profiles) {
  runProfile(profile)
}

console.log('\n' + '='.repeat(72))
console.log('Why the old benchmark was misleading')
console.log('='.repeat(72))
console.log('• Keeping MiniSearch + FrozenMiniSearch together doubles RAM after freeze().')
console.log('• storeFields duplicates document text — dominates heap; use "index only" profile to see structural gains.')
console.log('• Production: build mutable → freeze() → release mutable → serve frozen (or loadBinary).\n')
