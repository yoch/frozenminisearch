/**
 * Micro-benchmark: SearchableMap#fuzzyGet vs PackedRadixTree#fuzzyEntries
 * on identical radix trees (same corpora / Divina index).
 */
import Benchmark from 'benchmark'
import SearchableMap from '../src/SearchableMap/SearchableMap.js'
import { fromRadixTree } from '../src/PackedRadixTree/index.js'
import { index as divinaIndex } from './divinaCommedia.js'
import { corpora } from './packedRadixCorpora.js'
import { DIVINA_FUZZY_CASES, fuzzyCasesFromProbe } from './packedRadixFuzzyCases.js'
import {
  loadMedicamentsCorpora,
  medicamentsFuzzyCases,
  printMedicamentsAnalysis,
} from './medicamentsIndexes.js'

const BENCH_OPTS = { minSamples: 12, minTime: 0.15 }

/** Corpora included in the fuzzy comparison grid. */
const FUZZY_CORPUS_IDS = [
  'small',
  'dense-prefix',
  'scale',
  'prefix-suffix-5k',
  'short5-alphabet800-10k',
]

function pctPackedVsMap (mapHz, packedHz) {
  if (mapHz === 0) return null
  return Number((((packedHz - mapHz) / mapHz) * 100).toFixed(1))
}

function runPairSuite (suiteName, map, packed, cases) {
  const suite = new Benchmark.Suite(suiteName)
  for (const { query, maxDistance, label } of cases) {
    const tag = label ?? `${query}@k=${maxDistance}`
    suite
      .add(`map ${tag}`, () => { map.fuzzyGet(query, maxDistance) }, BENCH_OPTS)
      .add(`packed ${tag}`, () => { Array.from(packed.fuzzyEntries(query, maxDistance)) }, BENCH_OPTS)
  }

  return new Promise((resolve) => {
    const rows = []
    suite.on('cycle', (event) => {
      const bench = event.target
      rows.push({
        name: bench.name,
        hz: bench.hz,
        meanMs: bench.stats.mean * 1000,
      })
    })
    suite.on('complete', () => {
      const byTag = new Map()
      for (const row of rows) {
        const isMap = row.name.startsWith('map ')
        const tag = row.name.slice(isMap ? 4 : 7)
        const entry = byTag.get(tag) ?? { tag }
        if (isMap) {
          entry.mapHz = row.hz
          entry.mapMeanMs = row.meanMs
        } else {
          entry.packedHz = row.hz
          entry.packedMeanMs = row.meanMs
        }
        byTag.set(tag, entry)
      }
      const summary = [...byTag.values()].map((e) => ({
        ...e,
        packedVsMapPct: e.mapHz != null && e.packedHz != null
          ? pctPackedVsMap(e.mapHz, e.packedHz)
          : null,
      }))
      resolve(summary)
    })
    suite.run()
  })
}

function buildPair (entries) {
  const map = SearchableMap.from(entries)
  const packed = fromRadixTree(map.radixTree, map.size)
  return { map, packed, size: map.size }
}

async function benchCorpus (corpus) {
  const { map, packed, size } = buildPair(corpus.entries)
  const cases = fuzzyCasesFromProbe(corpus.probes.fuzzyQuery).map((c) => ({
    ...c,
    label: `${corpus.id} ${c.label}`,
  }))
  const summary = await runPairSuite(`corpus:${corpus.id}`, map, packed, cases)
  return { corpusId: corpus.id, termCount: size, summary }
}

async function benchMedicamentsCorpus (corpus) {
  const cases = medicamentsFuzzyCases(corpus)
  const summary = await runPairSuite(`medicaments:${corpus.id}`, corpus.map, corpus.tree, cases)
  return { corpusId: corpus.id, termCount: corpus.analysis.termCount, summary }
}

async function benchDivina () {
  const map = divinaIndex
  const packed = fromRadixTree(map.radixTree, map.size)
  const cases = DIVINA_FUZZY_CASES.map((c) => ({
    ...c,
    label: `divina ${c.query}@k=${c.maxDistance}`,
  }))
  const summary = await runPairSuite('divina', map, packed, cases)
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
      + `\n    map:    ${row.mapHz.toFixed(0)} ops/s  (${row.mapMeanMs.toFixed(3)} ms)`
      + `\n    packed: ${row.packedHz.toFixed(0)} ops/s  (${row.packedMeanMs.toFixed(3)} ms)`
      + `\n    packed vs map: ${pctStr}`,
    )
  }
}

async function main () {
  const gcNote = global.gc ? '' : ' (warn: --expose-gc recommended)'
  console.log(`PackedRadixTree fuzzy micro-benchmark${gcNote}`)
  console.log(`Options: minSamples=${BENCH_OPTS.minSamples}, minTime=${BENCH_OPTS.minTime}s`)

  const results = []
  const medicaments = loadMedicamentsCorpora()
  printMedicamentsAnalysis(medicaments)

  for (const corpus of corpora.filter((c) => FUZZY_CORPUS_IDS.includes(c.id))) {
    results.push(await benchCorpus(corpus))
  }
  for (const med of medicaments) {
    results.push(await benchMedicamentsCorpus(med))
  }
  results.push(await benchDivina())

  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY (packed vs map, + = packed faster)')
  console.log('='.repeat(60))

  for (const result of results) {
    printSection(result)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
