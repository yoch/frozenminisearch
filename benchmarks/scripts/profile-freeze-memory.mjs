/**
 * Memory pressure of the freeze import intermediate (parseSnapshotIndex accumulator).
 *
 * The freeze path streams postings into an IncrementalPostingsAccumulator during
 * JSON parse before finalize emits typed arrays. This probe sizes that intermediate
 * and guards it against a reference Map<fieldId, Map<shortId,freq>> representation in the same
 * process.
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-freeze-memory.mjs
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/profile-freeze-memory.mjs --runs=5
 */
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import {
  frozenFromMiniSearchSnapshot,
  parseSnapshotIndex,
} from '../../src/internal/frozenInternals.ts'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { measureHeap, gc, medianOf } from '../benchmarkUtils.js'
import { intArg } from './cpuBenchUtils.mjs'

const SCENARIOS = {
  dense: 'denseNumericIds-100k',
  highFrequency: 'extreme-highFrequency',
  overflow: 'extreme-overflowFrequency',
  giant: 'extreme-giantVocabulary',
  docId: 'docIdUint16Boundary-65536',
}

const runs = intArg('runs', 3, { min: 1 })

/** Reference representation the parsed intermediate must not regress beyond. */
function buildMapIntermediate(snapshot) {
  const { index: entries, serializationVersion } = snapshot
  const out = new Array(entries.length)
  for (let ti = 0; ti < entries.length; ti++) {
    const data = entries[ti][1]
    const dataMap = new Map()
    for (const fieldId of Object.keys(data)) {
      const raw = data[fieldId]
      const rec = serializationVersion === 1 && raw != null && typeof raw === 'object' && 'ds' in raw
        ? raw.ds
        : raw
      const freqs = new Map()
      for (const [docId, freq] of Object.entries(rec)) {
        freqs.set(Number(docId), freq)
      }
      dataMap.set(Number(fieldId), freqs)
    }
    out[ti] = dataMap
  }
  return out
}

function medianMb(samples) {
  return Number(medianOf(samples).toFixed(3))
}

function run(scenarioKey) {
  const scenario = getScenarioById(SCENARIOS[scenarioKey])
  const { corpus, options } = scenario
  const ms = new MiniSearch(options)
  ms.addAll(corpus)
  const snapshot = ms.toJSON()
  const fieldCount = options.fields.length
  const nextId = snapshot.nextId

  const arrayIntermediate = []
  const mapIntermediate = []
  const finalIndex = []
  const transientPeak = []

  for (let i = 0; i < runs; i++) {
    gc()
    // Isolate the postings intermediate: keep only the accumulator alive so the
    // PackedRadixTree built alongside is collected and not counted here.
    arrayIntermediate.push(
      measureHeap(() => parseSnapshotIndex(snapshot, fieldCount, nextId).accumulator).heapBytes,
    )
    gc()
    mapIntermediate.push(measureHeap(() => buildMapIntermediate(snapshot)).heapBytes)
    gc()
    finalIndex.push(measureHeap(() => frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options)).heapBytes)

    // Transient peak estimate: heapUsed just after the synchronous import,
    // before GC reclaims the dead intermediate, above a freshly-gc'd baseline.
    gc()
    const baseline = process.memoryUsage().heapUsed
    const frozen = frozenFromMiniSearchSnapshot(FrozenMiniSearch, snapshot, options)
    const afterCall = process.memoryUsage().heapUsed
    void frozen.documentCount
    transientPeak.push(afterCall - baseline)
  }

  const toMb = (b) => b / 1024 / 1024
  return {
    id: scenario.id,
    docs: corpus.length,
    terms: snapshot.index.length,
    arrayIntermediateMb: medianMb(arrayIntermediate.map(toMb)),
    mapIntermediateMb: medianMb(mapIntermediate.map(toMb)),
    finalIndexMb: medianMb(finalIndex.map(toMb)),
    transientPeakMb: medianMb(transientPeak.map(toMb)),
  }
}

const keys = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1]?.split(',')
  ?? Object.keys(SCENARIOS)

if (typeof global.gc !== 'function') {
  console.warn('Warning: run with --expose-gc for stable heap measurements\n')
}

console.log(`Freeze import memory — runs=${runs} (retained heap of intermediate vs final)\n`)
console.log(
  `${'scenario'.padEnd(30)} ${'terms'.padStart(8)} ${'current'.padStart(9)} ${'mapRef'.padStart(9)} ${'Δ vs ref'.padStart(12)} ${'final'.padStart(9)} ${'transient'.padStart(10)}`,
)
console.log('─'.repeat(92))

for (const key of keys) {
  const r = run(key)
  const delta = r.arrayIntermediateMb - r.mapIntermediateMb
  const deltaPct = r.mapIntermediateMb > 0 ? (delta / r.mapIntermediateMb) * 100 : 0
  console.log(
    `${r.id.padEnd(30)} ${String(r.terms).padStart(8)} ${`${r.arrayIntermediateMb}`.padStart(9)} ${`${r.mapIntermediateMb}`.padStart(9)} ${`${delta >= 0 ? '+' : ''}${delta.toFixed(2)} (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}%)`.padStart(12)} ${`${r.finalIndexMb}`.padStart(9)} ${`${r.transientPeakMb}`.padStart(10)}`,
  )
}
console.log('\nAll values MB. current=parseSnapshotIndex intermediate, mapRef=reference Map representation.')
console.log('transient = heapUsed delta right after import before GC (dead intermediate still resident).')
