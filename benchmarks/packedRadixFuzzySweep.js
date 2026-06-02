/**
 * Fuzzy sweep: many real terms × typo mutations × k — median time per query (map vs packed).
 *
 *   yarn benchmark:packed-fuzzy-sweep
 *   QUERIES=8000 ITERS=5 CORPUS=bdpm-presentations yarn benchmark:packed-fuzzy-sweep
 */
import SearchableMap from '../src/SearchableMap/SearchableMap.js'
import { index as divinaIndex } from './divinaCommedia.js'
import {
  buildFuzzySweepQueries,
  collectTerms,
  planSweepSize,
} from './fuzzyQueryMutations.js'
import { loadMedicamentsCorpora } from './medicamentsIndexes.js'
import { printEdgeLabelHistogram } from './packedRadixEdgeStats.js'
import { fromRadixTree } from '../src/PackedRadixTree/index.js'

const DEFAULT_TARGET_QUERIES = 10000
const DEFAULT_WARMUP_QUERIES = 1000
const DEFAULT_ITERS = 5
const DEFAULT_SEED = 0x53574545 // 'SWEE'
const WARMUP_SEED_XOR = 0x5741524d // 'WARM'

function envInt (name, fallback) {
  const raw = process.env[name]
  if (raw == null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function parseCorpusId () {
  return process.env.CORPUS ?? 'bdpm-presentations'
}

function median (values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** % latency gain for packed vs map (+ = packed faster). */
function packedVsMapLatencyPct (mapMs, packedMs) {
  if (mapMs === 0) return null
  return Number((((mapMs - packedMs) / mapMs) * 100).toFixed(1))
}

function medianTimed (fn, iters) {
  const samples = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return median(samples)
}

function loadCorpus (corpusId) {
  if (corpusId === 'divina') {
    const map = divinaIndex
    return {
      id: 'divina',
      map,
      tree: fromRadixTree(map.radixTree, map.size),
      termCount: map.size,
    }
  }

  const medicaments = loadMedicamentsCorpora()
  const med = medicaments.find((c) => c.id === corpusId)
  if (med) {
    return {
      id: med.id,
      map: med.map,
      tree: med.tree,
      termCount: med.analysis.termCount,
    }
  }

  throw new Error(`Unknown CORPUS="${corpusId}". Use divina or a medicaments id (bdpm-presentations, …).`)
}

function aggregateBy (rows, keyFn) {
  const groups = new Map()
  for (const row of rows) {
    const key = keyFn(row)
    const g = groups.get(key) ?? { key, mapMs: [], packedMs: [] }
    g.mapMs.push(row.mapMs)
    g.packedMs.push(row.packedMs)
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => {
    const mapMed = median(g.mapMs)
    const packedMed = median(g.packedMs)
    return {
      key: g.key,
      count: g.mapMs.length,
      mapMs: mapMed,
      packedMs: packedMed,
      packedVsMapPct: packedVsMapLatencyPct(mapMed, packedMed),
    }
  }).sort((a, b) => String(a.key).localeCompare(String(b.key)))
}

function termSampleForTarget (targetQueries, includeDoubleEdits) {
  const plan = planSweepSize({ termCount: 1, includeDoubleEdits })
  return Math.max(1, Math.ceil(targetQueries / plan.mutationsPerTerm))
}

function runPathWarmup (corpus, cases, label) {
  if (cases.length === 0) return
  const reportEvery = Math.max(500, Math.floor(cases.length / 5))
  console.log(`\n${label}: ${cases.length} queries (untimed, map + packed each)`)
  const t0 = performance.now()
  let done = 0
  for (const c of cases) {
    corpus.map.fuzzyGet(c.query, c.maxDistance)
    Array.from(corpus.tree.fuzzyEntries(c.query, c.maxDistance))
    done++
    if (done % reportEvery === 0) {
      console.log(`  … ${done}/${cases.length}`)
    }
  }
  console.log(`  warmup done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
}

async function main () {
  const targetQueries = envInt('QUERIES', DEFAULT_TARGET_QUERIES)
  const warmupQueries = envInt('WARMUP', DEFAULT_WARMUP_QUERIES)
  const iters = envInt('ITERS', DEFAULT_ITERS)
  const corpusId = parseCorpusId()
  const seed = envInt('SEED', DEFAULT_SEED)
  const includeDoubleEdits = process.env.NO_DOUBLE_EDITS !== '1'

  const corpus = loadCorpus(corpusId)
  const edgeHist = printEdgeLabelHistogram(corpus.tree, corpus.id)
  const terms = collectTerms(corpus.tree)
  const termSample = termSampleForTarget(targetQueries, includeDoubleEdits)
  const warmupTermSample = termSampleForTarget(warmupQueries, includeDoubleEdits)
  const plan = planSweepSize({ termCount: termSample, includeDoubleEdits })

  const warmupCases = buildFuzzySweepQueries({
    terms,
    termSample: warmupTermSample,
    seed: (seed ^ WARMUP_SEED_XOR) >>> 0,
    includeDoubleEdits,
  })

  const cases = buildFuzzySweepQueries({
    terms,
    termSample,
    seed,
    includeDoubleEdits,
  })

  if (global.gc) global.gc()

  console.log(`Fuzzy query sweep (${corpus.id}, ${corpus.termCount} terms in index)`)
  console.log(`  timed: target≈${targetQueries} | actual=${cases.length} | iters/query=${iters}`)
  console.log(`  warmup: target≈${warmupQueries} | actual=${warmupCases.length}`)
  console.log(`  timed sample=${termSample} terms × ~${plan.mutationsPerTerm} (mutation,k) pairs`)
  console.log(`  mutations: ${plan.singleMutations} single + ${plan.doubleMutations} double edits`)
  console.log(`  total timed runs: ${cases.length * iters * 2} (map+packed)`)

  runPathWarmup(corpus, warmupCases, 'Path warmup')

  if (global.gc) global.gc()

  console.log('\nTimed sweep')
  const sweepT0 = performance.now()

  const rows = []
  let done = 0
  const reportEvery = Math.max(500, Math.floor(cases.length / 10))

  for (const c of cases) {
    const mapMs = medianTimed(() => { corpus.map.fuzzyGet(c.query, c.maxDistance) }, iters)
    const packedMs = medianTimed(
      () => { Array.from(corpus.tree.fuzzyEntries(c.query, c.maxDistance)) },
      iters,
    )
    rows.push({
      ...c,
      mapMs,
      packedMs,
      packedVsMapPct: packedVsMapLatencyPct(mapMs, packedMs),
    })
    done++
    if (done % reportEvery === 0) {
      console.log(`  … ${done}/${cases.length}`)
      if (global.gc) global.gc()
    }
  }

  const allMap = rows.map((r) => r.mapMs)
  const allPacked = rows.map((r) => r.packedMs)
  const globalMapMed = median(allMap)
  const globalPackedMed = median(allPacked)
  const globalMapP95 = [...allMap].sort((a, b) => a - b)[Math.floor(allMap.length * 0.95)] ?? 0
  const globalPackedP95 = [...allPacked].sort((a, b) => a - b)[Math.floor(allPacked.length * 0.95)] ?? 0

  const meanMap = allMap.reduce((a, b) => a + b, 0) / allMap.length
  const meanPacked = allPacked.reduce((a, b) => a + b, 0) / allPacked.length

  console.log('\n' + '='.repeat(60))
  console.log('GLOBAL (median of per-query medians)')
  console.log('='.repeat(60))
  console.log(`  map:    ${globalMapMed.toFixed(3)} ms median  |  ${meanMap.toFixed(3)} ms mean  |  ${globalMapP95.toFixed(3)} ms p95`)
  console.log(`  packed: ${globalPackedMed.toFixed(3)} ms median  |  ${meanPacked.toFixed(3)} ms mean  |  ${globalPackedP95.toFixed(3)} ms p95`)
  const medPct = packedVsMapLatencyPct(globalMapMed, globalPackedMed)
  const meanPct = packedVsMapLatencyPct(meanMap, meanPacked)
  console.log(`  packed vs map (median): ${medPct >= 0 ? '+' : ''}${medPct}% faster`)
  console.log(`  packed vs map (mean):   ${meanPct >= 0 ? '+' : ''}${meanPct}% faster`)

  console.log('\nBy maxDistance (k)')
  for (const row of aggregateBy(rows, (r) => `k=${r.maxDistance}`)) {
    console.log(
      `  ${row.key}: n=${row.count}  map=${row.mapMs.toFixed(3)}ms  packed=${row.packedMs.toFixed(3)}ms  ${row.packedVsMapPct >= 0 ? '+' : ''}${row.packedVsMapPct}%`,
    )
  }

  console.log('\nBy mutation kind')
  for (const row of aggregateBy(rows, (r) => r.mutation)) {
    console.log(
      `  ${row.key}: n=${row.count}  map=${row.mapMs.toFixed(3)}ms  packed=${row.packedMs.toFixed(3)}ms  ${row.packedVsMapPct >= 0 ? '+' : ''}${row.packedVsMapPct}%`,
    )
  }

  console.log('\nBy query length')
  for (const row of aggregateBy(rows, (r) => {
    const len = r.query.length
    if (len <= 4) return 'len 2-4'
    if (len <= 8) return 'len 5-8'
    if (len <= 14) return 'len 9-14'
    return 'len 15+'
  })) {
    console.log(
      `  ${row.key}: n=${row.count}  map=${row.mapMs.toFixed(3)}ms  packed=${row.packedMs.toFixed(3)}ms  ${row.packedVsMapPct >= 0 ? '+' : ''}${row.packedVsMapPct}%`,
    )
  }

  const sweepSec = (performance.now() - sweepT0) / 1000
  console.log(`\nTimed sweep wall: ${sweepSec.toFixed(1)}s (${(cases.length / sweepSec).toFixed(0)} queries/s)`)

  console.log(`\nEdge mean label length: ${edgeHist.mean}`)
  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
