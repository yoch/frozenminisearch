/**
 * Compare SearchableMap#fuzzyGet vs PackedRadixTree#fuzzyRefs (+ termByIndex) on identical trees.
 * Uses interleaved map/packed timing (one variant per round) for stable packed-vs-map ratios.
 */
import SearchableMap, { packSearchableMap } from '../testSupport/upstreamSearchableMap.js'
import { index as divinaIndex } from './divinaCommedia.js'
import { corpora } from './packedRadixCorpora.js'
import { DIVINA_FUZZY_CASES, fuzzyCasesFromProbe } from './packedRadixFuzzyCases.js'
import {
  loadMedicamentsCorpora,
  medicamentsFuzzyCases,
  printMedicamentsAnalysis,
} from './medicamentsIndexes.js'
import { median } from './benchmarkUtils.js'

const WARMUP = 5
const RUNS = 25

const ALL_SYNTHETIC_IDS = [
  'small',
  'dense-prefix',
  'scale',
  'prefix-suffix-5k',
  'short5-alphabet800-10k',
]

const DEFAULT_SYNTHETIC_IDS = ['scale', 'prefix-suffix-5k', 'dense-prefix']
const QUICK_SYNTHETIC_IDS = ['scale']
const DEFAULT_MEDICAMENT_IDS = ['bdpm-presentations', 'bdpm-specialites']
const QUICK_MEDICAMENT_IDS = ['bdpm-presentations']

function pctPackedVsMap (mapHz, packedHz) {
  if (mapHz === 0) return null
  return Number((((packedHz - mapHz) / mapHz) * 100).toFixed(1))
}

/**
 * Interleaved timing: each round runs map then packed (same query/k); median after warmup.
 */
function benchCaseInterleaved (map, packed, { query, maxDistance }) {
  const mapTimes = []
  const packedTimes = []
  for (let round = 0; round < WARMUP + RUNS; round++) {
    let t0 = performance.now()
    map.fuzzyGet(query, maxDistance)
    const mapMs = performance.now() - t0
    t0 = performance.now()
    Array.from(packed.fuzzyRefs(query, maxDistance))
      .map(({ termIndex, distance }) => [packed.termByIndex(termIndex), termIndex, distance])
    const packedMs = performance.now() - t0
    if (round >= WARMUP) {
      mapTimes.push(mapMs)
      packedTimes.push(packedMs)
    }
  }
  const mapMedianMs = median(mapTimes)
  const packedMedianMs = median(packedTimes)
  return {
    mapMedianMs,
    packedMedianMs,
    mapHz: 1000 / mapMedianMs,
    packedHz: 1000 / packedMedianMs,
    packedVsMapPct: pctPackedVsMap(1000 / mapMedianMs, 1000 / packedMedianMs),
  }
}

function runCaseSuite (map, packed, cases) {
  return cases.map(({ query, maxDistance, label }) => {
    const tag = label ?? `${query}@k=${maxDistance}`
    const timing = benchCaseInterleaved(map, packed, { query, maxDistance })
    return { tag, ...timing }
  })
}

function buildPair (entries) {
  const map = SearchableMap.from(entries)
  const packed = packSearchableMap(map)
  return { map, packed, size: map.size }
}

function benchCorpus (corpus) {
  const { map, packed, size } = buildPair(corpus.entries)
  const cases = fuzzyCasesFromProbe(corpus.probes.fuzzyQuery).map((c) => ({
    ...c,
    label: `${corpus.id} ${c.label}`,
  }))
  const summary = runCaseSuite(map, packed, cases)
  return { corpusId: corpus.id, termCount: size, summary }
}

function benchMedicamentsCorpus (corpus) {
  const cases = medicamentsFuzzyCases(corpus)
  const summary = runCaseSuite(corpus.map, corpus.tree, cases)
  return { corpusId: corpus.id, termCount: corpus.analysis.termCount, summary }
}

function benchDivina () {
  const map = divinaIndex
  const packed = packSearchableMap(map)
  const cases = DIVINA_FUZZY_CASES.map((c) => ({
    ...c,
    label: `divina ${c.query}@k=${c.maxDistance}`,
  }))
  const summary = runCaseSuite(map, packed, cases)
  return { corpusId: 'divina-commedia', termCount: map.size, summary }
}

function printSection (result) {
  console.log(`\n${result.corpusId} (${result.termCount} terms)`)
  console.log('─'.repeat(60))
  for (const row of result.summary) {
    const pct = row.packedVsMapPct
    const pctStr = pct == null ? 'n/a' : `${pct >= 0 ? '+' : ''}${pct}%`
    console.log(
      `  ${row.tag}`
      + `\n    map:    ${row.mapHz.toFixed(0)} ops/s  (${row.mapMedianMs.toFixed(3)} ms median)`
      + `\n    packed: ${row.packedHz.toFixed(0)} ops/s  (${row.packedMedianMs.toFixed(3)} ms median)`
      + `\n    packed vs map: ${pctStr}  (+ = packed faster)`,
    )
  }
}

function resolveBenchPlan (argv) {
  const full = argv.includes('--full')
  const quick = argv.includes('--quick')
  if (full && quick) {
    throw new Error('Use only one of --quick or --full')
  }
  return {
    syntheticIds: quick ? QUICK_SYNTHETIC_IDS : full ? ALL_SYNTHETIC_IDS : DEFAULT_SYNTHETIC_IDS,
    medicamentIds: quick ? QUICK_MEDICAMENT_IDS : full ? null : DEFAULT_MEDICAMENT_IDS,
    includeDivina: full,
    label: quick ? 'quick' : full ? 'full' : 'default',
  }
}

function main () {
  const plan = resolveBenchPlan(process.argv)
  const gcNote = global.gc ? '' : ' (warn: --expose-gc recommended)'
  console.log(`PackedRadixTree fuzzy micro-benchmark${gcNote}`)
  console.log(
    `Mode: ${plan.label} | interleaved map/packed | warmup=${WARMUP} runs=${RUNS} (median ms)`,
  )

  const results = []
  const medicaments = loadMedicamentsCorpora({ withMap: true, ids: plan.medicamentIds })
  printMedicamentsAnalysis(medicaments)

  for (const corpus of corpora.filter((c) => plan.syntheticIds.includes(c.id))) {
    results.push(benchCorpus(corpus))
  }
  for (const med of medicaments) {
    results.push(benchMedicamentsCorpus(med))
  }
  if (plan.includeDivina) {
    results.push(benchDivina())
  }

  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))

  for (const result of results) {
    printSection(result)
  }

  console.log('\nDone.')
}

try {
  main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
