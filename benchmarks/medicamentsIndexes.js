/**
 * Load real FrozenMiniSearch term trees from binary fixtures for packed radix benchmarks.
 * Fixtures: benchmarks/fixtures/medicaments-indexes/
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFrozenSnapshotMsv5 } from '../src/msv5/binaryMsv5Decode.ts'
import SearchableMap from '../src/SearchableMap/SearchableMap.js'
import { measureStructuredBytes } from './packedRadixMetrics.js'
import { fuzzyCasesFromProbe } from './packedRadixFuzzyCases.js'

export function resolveFixturesDir () {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'fixtures/medicaments-indexes'),
    join(here, '..', 'fixtures/medicaments-indexes'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'bdpm-manifest.json'))) return dir
  }
  throw new Error(
    'Medicaments fixtures missing. Copy binary indexes to benchmarks/fixtures/medicaments-indexes/ (see README there).',
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

/** @type {Record<string, (corpus: object) => Array<{ query: string, maxDistance: number, label: string }>>} */
const MEDICAMENTS_FUZZY_EXTRA_CASES = {
  'bdpm-specialites': (corpus) => [
    { query: 'doliprane', maxDistance: 1, label: `${corpus.id} doliprane@k=1` },
    { query: 'dolipran', maxDistance: 1, label: `${corpus.id} dolipran@k=1` },
  ],
  'bdpm-substances': (corpus) => {
    const seed = corpus.probes.fuzzySeed
    if (!seed) return []
    return [{
      query: fuzzyProbe(seed),
      maxDistance: 1,
      label: `${corpus.id} seed-typo@k=1`,
    }]
  },
}

let manifestCache
/** @type {Map<string, object>} */
const corpusCache = new Map()

export function loadManifests () {
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
 * @param {string} id
 * @param {{ withMap?: boolean }} [options]
 */
export function loadMedicamentsCorpus (id, { withMap = false } = {}) {
  const cacheKey = `${id}:${withMap ? 1 : 0}`
  const cached = corpusCache.get(cacheKey)
  if (cached) return cached

  const spec = MEDICAMENTS_INDEX_SPECS.find((s) => s.id === id)
  if (!spec) {
    throw new Error(`Unknown medicaments corpus id: ${id}`)
  }

  const manifests = loadManifests()
  const { tree, snap } = loadPackedTreeFromMsbin(spec.file)
  const analysis = analyzePackedTree(tree)
  const manifestEntry = manifests[spec.source].indexes[spec.manifestKey]

  const corpus = {
    id: spec.id,
    tree,
    map: withMap ? searchableMapFromPackedTree(tree) : null,
    probes: probesForTree(analysis),
    analysis,
    benchCpu: spec.id === 'bdpm-presentations' || spec.id === 'bdpm-specialites',
    meta: {
      kind: 'medicaments-binary',
      source: spec.source,
      manifestKey: spec.manifestKey,
      file: spec.file,
      fileBytes: manifestEntry?.bytes,
      documentCount: snap.documentCount,
      manifestTermCount: manifestEntry?.termCount,
      ...analysis,
    },
  }

  corpusCache.set(cacheKey, corpus)
  return corpus
}

/**
 * @param {{ withMap?: boolean, ids?: string[] | null }} [options]
 */
export function loadMedicamentsCorpora ({ withMap = false, ids = null } = {}) {
  const specs = ids
    ? MEDICAMENTS_INDEX_SPECS.filter((s) => ids.includes(s.id))
    : MEDICAMENTS_INDEX_SPECS
  return specs.map((s) => loadMedicamentsCorpus(s.id, { withMap }))
}

/** Extra fuzzy cases tuned per index (French pharma-ish typos). */
export function medicamentsFuzzyCases (corpus) {
  const cases = fuzzyCasesFromProbe(corpus.probes.fuzzyQuery).map((c) => ({
    ...c,
    label: `${corpus.id} ${c.label}`,
  }))

  const extra = MEDICAMENTS_FUZZY_EXTRA_CASES[corpus.id]
  if (extra) cases.push(...extra(corpus))

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
