import { loadDivinaLines } from './loadDivinaLines.js'
import {
  giantVocabulary,
  largeDocuments,
  manyFields,
  highFrequencyTerms,
  overflowFrequencies,
  denseNumericIds,
  genericStringIds,
  sparseFields,
  docIdUint16Boundary,
} from './benchmarkScenarios.js'

export function buildScenarioList () {
  const divina = loadDivinaLines()
  const many = manyFields()
  const sparse = sparseFields(5000, 20)

  return [
    {
      id: 'divina-storeFields',
      name: 'Divina Commedia — with storeFields',
      corpus: divina,
      options: { fields: ['txt'], storeFields: ['txt'] },
      queries: [
        { label: 'exact', q: 'inferno', opts: {} },
        { label: 'AND', q: 'inferno paradiso', opts: { combineWith: 'AND' } },
        { label: 'AND+prefix', q: 'infe para', opts: { combineWith: 'AND', prefix: true } },
        { label: 'AND+fuzzy', q: 'infern paradis', opts: { combineWith: 'AND', fuzzy: 0.2 } },
        { label: 'AND_NOT', q: 'inferno paradiso', opts: { combineWith: 'AND_NOT' } },
        { label: 'AND_NOT+prefix', q: 'infe para', opts: { combineWith: 'AND_NOT', prefix: true } },
        { label: 'prefix', q: 'infe', opts: { prefix: true } },
        { label: 'fuzzy', q: 'infern', opts: { fuzzy: 0.2 } },
      ],
    },
    {
      id: 'divina-indexOnly',
      name: 'Divina Commedia — index only',
      corpus: divina,
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'inferno', opts: {} },
        { label: 'prefix', q: 'infe', opts: { prefix: true } },
      ],
    },
    {
      id: 'extreme-giantVocabulary',
      name: 'Extreme — giant vocabulary (50k unique terms)',
      corpus: giantVocabulary(50000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'unique12345', opts: {} },
        { label: 'AND+prefix', q: 'unique1 common', opts: { combineWith: 'AND', prefix: true } },
        { label: 'AND_NOT', q: 'unique1 common', opts: { combineWith: 'AND_NOT' } },
        { label: 'prefix', q: 'unique1', opts: { prefix: true } },
      ],
    },
    {
      id: 'extreme-largeDocuments',
      name: 'Extreme — large documents (5k × ~5KB, storeFields)',
      corpus: largeDocuments(5000, 5000),
      options: { fields: ['txt'], storeFields: ['txt'] },
      queries: [
        { label: 'exact', q: 'lorem', opts: {} },
        { label: 'AND', q: 'lorem ipsum', opts: { combineWith: 'AND' } },
      ],
    },
    {
      id: 'extreme-manyFields',
      name: 'Extreme — many fields (2k docs × 10 fields)',
      corpus: many.docs,
      options: { fields: many.fields, storeFields: [] },
      queries: [
        { label: 'exact', q: 'sharedterm', opts: {} },
        { label: 'prefix', q: 'share', opts: { prefix: true } },
      ],
    },
    {
      id: 'extreme-highFrequency',
      name: 'Extreme — high-frequency terms (10k docs)',
      corpus: highFrequencyTerms(10000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} },
        { label: 'AND', q: 'alpha beta', opts: { combineWith: 'AND' } },
      ],
    },
    {
      id: 'extreme-overflowFrequency',
      name: 'Extreme — overflow frequencies (>255)',
      corpus: overflowFrequencies(2000, 800),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} },
      ],
      driftQueries: ['alpha'],
    },
    {
      id: 'denseNumericIds-100k',
      name: 'Dense numeric ids (100k, identity lookup)',
      corpus: denseNumericIds(100000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'token42', opts: {} },
      ],
    },
    {
      id: 'genericStringIds-100k',
      name: 'Generic string ids (100k, lazy-map lookup)',
      corpus: genericStringIds(100000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'token42', opts: {} },
      ],
    },
    {
      id: 'sparseFields-50kTerms-20Fields',
      name: 'Sparse fields (5k docs × 20 fields, one active field/doc)',
      corpus: sparse.docs,
      options: {
        fields: sparse.fields,
        storeFields: [],
      },
      queries: [
        { label: 'exact', q: 'shared', opts: {} },
      ],
    },
    {
      id: 'docIdUint16Boundary-65535',
      name: 'Doc id Uint16 boundary (65535 docs)',
      corpus: docIdUint16Boundary(65535),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} },
      ],
    },
    {
      id: 'docIdUint16Boundary-65536',
      name: 'Doc id Uint32 boundary (65536 docs)',
      corpus: docIdUint16Boundary(65536),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} },
      ],
    },
    {
      id: 'saveBinaryAfterNoTerms',
      name: 'saveBinary dictionary rebuild (50k terms)',
      corpus: giantVocabulary(50000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'unique9999', opts: {} },
      ],
    },
  ]
}

let cachedById = null

export function getScenarioById (id) {
  if (!cachedById) {
    cachedById = new Map(buildScenarioList().map((s) => [s.id, s]))
  }
  return cachedById.get(id) ?? null
}
