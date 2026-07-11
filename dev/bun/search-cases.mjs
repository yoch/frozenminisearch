/**
 * Search investigation case registry (experimental, under dev/bun/).
 * Synthetic scenarios from scenarioRegistry + medicaments load-only cases.
 * Avoid importing medicamentsIndexes.js here (it pulls TS decode paths).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getScenarioById } from '../../benchmarks/scenarioRegistry.mjs'

const SYNTHETIC_IDS = [
  'divina-indexOnly',
  'divina-storeFields',
  'extreme-giantVocabulary',
  'extreme-largeDocuments',
  'extreme-highFrequency',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
]

const GATE_THRESHOLD_LENGTHS = [1023, 1024, 1536, 2047, 2048]
const GATE_RATIO_LENGTHS = new Set([1024, 1536, 2047])
const GATE_THRESHOLD_DOC_COUNT = 2500
const gateThresholdCorpus = Array.from({ length: GATE_THRESHOLD_DOC_COUNT }, (_, i) => {
  const terms = []
  for (const length of GATE_THRESHOLD_LENGTHS) {
    if (i < length) terms.push(`wide${length}`)
    if (i < (length >>> 2)) terms.push(`gate${length}`)
    if (i < Math.max(251, length >>> 3)) terms.push(`narrow${length}`)
    if (i < (length >>> 2) + 1) terms.push(`over${length}`)
  }
  return { id: i, txt: terms.join(' ') }
})

/** Material cases for profiling / deeper A/B. */
export const PROFILE_CASE_KEYS = [
  'divina-storeFields:fuzzy',
  'divina-storeFields:AND+fuzzy',
  'extreme-largeDocuments:exact',
  'extreme-giantVocabulary:AND+prefix',
  'extreme-giantVocabulary:prefix',
  'docIdUint16Boundary-65536:exact',
  'extreme-highFrequency:AND',
  'bdpm-specialites:fuzzy-doliprane',
]

export const PRODUCT_AB_CASE_KEYS = [
  ...GATE_THRESHOLD_LENGTHS.flatMap(length => [
    `gate-threshold-${length}:sequential`,
    `gate-threshold-${length}:broad-first`,
    ...(GATE_RATIO_LENGTHS.has(length)
      ? [
          `gate-threshold-${length}:sequential-narrow`,
          `gate-threshold-${length}:broad-first-narrow`,
          `gate-threshold-${length}:sequential-over`,
          `gate-threshold-${length}:broad-first-over`,
        ]
      : []),
  ]),
  'extreme-giantVocabulary:AND+prefix',
  'extreme-largeDocuments:AND',
  'extreme-highFrequency:AND',
]

const MEDICAMENTS_INDEX_SPECS = [
  { id: 'bdpm-presentations', file: 'bdpm_presentations.msbin' },
  { id: 'bdpm-specialites', file: 'bdpm_specialites.msbin' },
  { id: 'bdpm-compositions', file: 'bdpm_compositions.msbin' },
  { id: 'bdpm-mitm', file: 'bdpm_mitm.msbin' },
  { id: 'bdpm-substances', file: 'bdpm_substances.msbin' },
  { id: 'bdpm-generiques', file: 'bdpm_generiques.msbin' },
  { id: 'vet-medicaments', file: 'vet_medicaments.msbin' },
]

function resolveFixturesDir () {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '../../benchmarks/fixtures/medicaments-indexes'),
    join(here, '../../../fixtures/medicaments-indexes'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'bdpm-manifest.json'))) return dir
  }
  throw new Error(
    'Medicaments fixtures missing. Copy binary indexes to benchmarks/fixtures/medicaments-indexes/',
  )
}

export function listSyntheticCases ({ only = null } = {}) {
  const cases = []
  for (const id of SYNTHETIC_IDS) {
    const scenario = getScenarioById(id)
    if (!scenario) continue
    for (const q of scenario.queries) {
      const key = `${id}:${q.label}`
      if (only != null && !only.includes(key) && !only.includes(id)) continue
      cases.push({
        key,
        kind: 'synthetic',
        scenarioId: id,
        label: q.label,
        query: q.q,
        opts: q.opts ?? {},
        options: scenario.options,
        corpus: scenario.corpus,
        hasMutable: true,
      })
    }
  }
  return cases
}

export function listGateThresholdCases ({ only = null } = {}) {
  const cases = []
  for (const length of GATE_THRESHOLD_LENGTHS) {
    const scenarioId = `gate-threshold-${length}`
    const specs = [
      {
        label: 'sequential',
        query: `gate${length} wide${length}`,
        gateSize: length >>> 2,
      },
      {
        label: 'broad-first',
        query: `wide${length} gate${length}`,
        gateSize: length >>> 2,
      },
    ]
    if (GATE_RATIO_LENGTHS.has(length)) {
      const narrowSize = Math.max(251, length >>> 3)
      const overSize = (length >>> 2) + 1
      specs.push(
        {
          label: 'sequential-narrow',
          query: `narrow${length} wide${length}`,
          gateSize: narrowSize,
        },
        {
          label: 'broad-first-narrow',
          query: `wide${length} narrow${length}`,
          gateSize: narrowSize,
        },
        {
          label: 'sequential-over',
          query: `over${length} wide${length}`,
          gateSize: overSize,
        },
        {
          label: 'broad-first-over',
          query: `wide${length} over${length}`,
          gateSize: overSize,
        },
      )
    }
    for (const spec of specs) {
      const key = `${scenarioId}:${spec.label}`
      if (only != null && !only.includes(key) && !only.includes(scenarioId)) continue
      cases.push({
        key,
        kind: 'synthetic',
        scenarioId,
        label: spec.label,
        query: spec.query,
        opts: { combineWith: 'AND' },
        options: { fields: ['txt'], storeFields: [] },
        corpus: gateThresholdCorpus,
        hasMutable: true,
        gateProbe: {
          documentCount: GATE_THRESHOLD_DOC_COUNT,
          postingLength: length,
          gateSize: spec.gateSize,
          gateRatio: Number((spec.gateSize / length).toFixed(6)),
        },
      })
    }
  }
  return cases
}

export function listMedicamentsCases ({ only = null } = {}) {
  const fixturesDir = resolveFixturesDir()
  const cases = []
  const querySpecs = [
    { label: 'exact-a', query: 'a', opts: {} },
    { label: 'prefix-par', query: 'par', opts: { prefix: true } },
    { label: 'fuzzy-doliprane', query: 'doliprane', opts: { fuzzy: 0.2 } },
  ]
  for (const spec of MEDICAMENTS_INDEX_SPECS) {
    for (const q of querySpecs) {
      if (q.label === 'fuzzy-doliprane' && spec.id !== 'bdpm-specialites') continue
      const key = `${spec.id}:${q.label}`
      if (only != null && !only.includes(key) && !only.includes(spec.id)) continue
      cases.push({
        key,
        kind: 'medicaments',
        scenarioId: spec.id,
        label: q.label,
        query: q.query,
        opts: q.opts,
        file: join(fixturesDir, spec.file),
        hasMutable: false,
      })
    }
  }
  return cases
}

export function listAllCases (opts = {}) {
  return [
    ...listSyntheticCases(opts),
    ...listGateThresholdCases(opts),
    ...listMedicamentsCases(opts),
  ]
}

export function listProfileCases () {
  return listAllCases({ only: PROFILE_CASE_KEYS })
}

export function caseByKey (key) {
  return listAllCases().find((c) => c.key === key) ?? null
}

export { SYNTHETIC_IDS }
