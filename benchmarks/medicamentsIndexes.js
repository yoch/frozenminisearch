/**
 * Load real FrozenMiniSearch term trees (MSv5) for packed radix benchmarks.
 * Fixtures: benchmarks/fixtures/medicaments-indexes/
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFrozenSnapshotMsv5 } from '../src/msv5/binaryMsv5Decode.ts'
import SearchableMap from '../src/SearchableMap/SearchableMap.js'
import { measureStructuredBytes } from './packedRadixMetrics.js'
import { fuzzyCasesFromProbe } from './packedRadixFuzzyCases.js'

function resolveFixturesDir () {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'fixtures/medicaments-indexes'),
    join(here, '..', 'fixtures/medicaments-indexes'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'bdpm-manifest.json'))) return dir
  }
  throw new Error(
    'Medicaments fixtures missing. Copy MSv5 indexes to benchmarks/fixtures/medicaments-indexes/ (see README there).',
  )
}

const FIXTURES_DIR = resolveFixturesDir()

/** @type {Array<{ id: string, file: string, source: string, manifestKey: string }>} */
export const MEDICAMENTS_INDEX_SPECS = [
  { id: 'bdpm-presentations', file: 'bdpm_presentations.msbin', source: 'bdpm', manifestKey: 'presentations' },
  { id: 'bdpm-specialites', file: 'bdpm_specialites.msbin', source: 'bdpm', manifestKey: 'specialites' },
  { id: 'bdpm-compositions', file: 'bdpm_compositions.msbin', source: 'bdpm', manifestKey: 'compositions' },
  { id: 'bdpm-mitm', file: 'bdpm_mitm.msbin', source: 'bdpm', manifestKey: 'mitm' },
  { id: 'bdpm-substances', file: 'bdpm_substances.msbin', source: 'bdpm', manifestKey: 'substances' },
  { id: 'bdpm-generiques', file: 'bdpm_generiques.msbin', source: 'bdpm', manifestKey: 'generiques' },
  { id: 'vet-medicaments', file: 'vet_medicaments.msbin', source: 'vet', manifestKey: 'medicaments' },
]

let manifestCache

function loadManifests () {
  if (manifestCache) return manifestCache
  const bdpm = JSON.parse(readFileSync(join(FIXTURES_DIR, 'bdpm-manifest.json'), 'utf8'))
  const vet = JSON.parse(readFileSync(join(FIXTURES_DIR, 'vet-manifest.json'), 'utf8'))
  manifestCache = { bdpm, vet }
  return manifestCache
}

export function loadPackedTreeFromMsbin (filename) {
  const buf = readFileSync(join(FIXTURES_DIR, filename))
  const snap = decodeFrozenSnapshotMsv5(buf)
  return { tree: snap.packedTermIndex, snap }
}

/** Scan terms once for stats and probe selection. */
export function analyzePackedTree (tree) {
  let termCount = 0
  let totalLen = 0
  let maxLen = 0
  let longest = ''
  let first = ''
  let fuzzySeed = ''

  for (const [term] of tree.entries()) {
    if (termCount === 0) first = term
    termCount++
    totalLen += term.length
    if (term.length > maxLen) {
      maxLen = term.length
      longest = term
    }
    if (
      !fuzzySeed
      && term.length >= 6
      && term.length <= 14
      && /[a-zàâçéèêëîïôùûü]/i.test(term)
    ) {
      fuzzySeed = term
    }
  }

  if (!fuzzySeed) fuzzySeed = first || 'x'

  const bytes = measureStructuredBytes(tree)

  return {
    termCount,
    avgTermLen: termCount ? Number((totalLen / termCount).toFixed(2)) : 0,
    maxTermLen: maxLen,
    longestTerm: longest,
    firstTerm: first,
    fuzzySeed,
    nodeCount: tree.nodeCount,
    edgeCount: tree.edgeCount,
    bytes,
  }
}

function fuzzyProbe (hit) {
  if (!hit || hit.length <= 1) return `${hit}z`
  const last = hit.charCodeAt(hit.length - 1)
  const repl = last === 122 || last === 57 ? 'a' : String.fromCharCode(last + 1)
  return hit.slice(0, -1) + repl
}

function probesForTree (analysis) {
  const hit = analysis.fuzzySeed
  return {
    getHit: analysis.firstTerm,
    getMiss: 'zzzzzzzzzzzzzzzz',
    prefixShort: hit.slice(0, 1),
    prefixLong: hit.slice(0, Math.min(4, hit.length)),
    fuzzyQuery: fuzzyProbe(hit),
    fuzzySeed: hit,
  }
}

export function searchableMapFromPackedTree (tree) {
  return SearchableMap.from(Array.from(tree.entries()))
}

/**
 * @returns {Array<{
 *   id: string,
 *   tree: import('../src/PackedRadixTree/PackedRadixTree').default,
 *   map: import('../src/SearchableMap/SearchableMap').default,
 *   probes: object,
 *   analysis: object,
 *   meta: object,
 *   benchCpu: boolean,
 * }>}
 */
export function loadMedicamentsCorpora () {
  const manifests = loadManifests()

  return MEDICAMENTS_INDEX_SPECS.map((spec) => {
    const { tree, snap } = loadPackedTreeFromMsbin(spec.file)
    const analysis = analyzePackedTree(tree)
    const manifestEntry = manifests[spec.source].indexes[spec.manifestKey]

    return {
      id: spec.id,
      tree,
      map: searchableMapFromPackedTree(tree),
      probes: probesForTree(analysis),
      analysis,
      benchCpu: spec.id === 'bdpm-presentations' || spec.id === 'bdpm-specialites',
      meta: {
        kind: 'medicaments-msv5',
        source: spec.source,
        manifestKey: spec.manifestKey,
        file: spec.file,
        fileBytes: manifestEntry?.bytes,
        documentCount: snap.documentCount,
        manifestTermCount: manifestEntry?.termCount,
        ...analysis,
      },
    }
  })
}

/** Extra fuzzy cases tuned per index (French pharma-ish typos). */
export function medicamentsFuzzyCases (corpus) {
  const seed = corpus.probes.fuzzySeed
  const cases = fuzzyCasesFromProbe(corpus.probes.fuzzyQuery).map((c) => ({
    ...c,
    label: `${corpus.id} ${c.label}`,
  }))

  if (corpus.id === 'bdpm-specialites') {
    cases.push(
      { query: 'doliprane', maxDistance: 1, label: `${corpus.id} doliprane@k=1` },
      { query: 'dolipran', maxDistance: 1, label: `${corpus.id} dolipran@k=1` },
    )
  }
  if (corpus.id === 'bdpm-substances' && seed) {
    cases.push({
      query: fuzzyProbe(seed),
      maxDistance: 1,
      label: `${corpus.id} seed-typo@k=1`,
    })
  }

  return cases
}

export function printMedicamentsAnalysis (corpora) {
  console.log('\nMedicaments indexes (fixtures/medicaments-indexes)')
  console.log('─'.repeat(72))
  for (const c of corpora) {
    const a = c.analysis
    console.log(
      `  ${c.id}`
      + ` | terms=${a.termCount} nodes=${a.nodeCount} edges=${a.edgeCount}`
      + ` | avgLen=${a.avgTermLen} maxLen=${a.maxTermLen}`
      + ` | structured≈${a.bytes.totalStructuredBytes}B`
      + ` | fuzzySeed="${c.probes.fuzzySeed}"`,
    )
  }
}
