import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'
import { expectSameResults } from './parityHarness.js'
import { expectSameIndexFingerprint } from '../../testSupport/indexFingerprint.js'
import {
  camelCaseOptions,
  defaultDocs,
  defaultOptions,
  indexingProfiles,
} from '../../testSupport/indexingProfiles.js'

function buildIndexingPair (docs, options) {
  const ms = new MiniSearch(options)
  ms.addAll(docs)
  const fr = FrozenMiniSearch.fromDocuments(docs, options)
  return { ms, fr }
}

function expectUpstreamIndexingParity (ms, fr, options, queries, { scorePrecision = 6 } = {}) {
  expectSameIndexFingerprint(ms.toJSON(), fr.toJSON())
  const searchOptions = options.searchOptions ?? {}
  for (const query of queries) {
    expectSameResults(ms, fr, query, searchOptions, { scorePrecision })
  }
}

describe('indexing parity — MiniSearch.addAll vs FrozenMiniSearch.fromDocuments', () => {
  test.each(indexingProfiles.map((p) => [p.name, p]))(
    'profile %s: fingerprint and search scores match',
    (_name, profile) => {
      const { ms, fr } = buildIndexingPair(profile.docs, profile.options)
      const scorePrecision = profile.name === 'vocs' ? 5 : 6
      expectUpstreamIndexingParity(ms, fr, profile.options, profile.queries, { scorePrecision })
    },
  )

  test('camelCase: create matches createUser in title field', () => {
    const { ms, fr } = buildIndexingPair(
      [{ id: '1', title: 'createUser', text: 'Create a new user.' }],
      camelCaseOptions,
    )
    const searchOptions = {
      ...camelCaseOptions.searchOptions,
      prefix: false,
      fuzzy: false,
      fields: ['title'],
      boostDocument: undefined,
    }
    const msHits = ms.search('create', searchOptions)
    const frHits = fr.search('create', searchOptions)
    expect(frHits.map((h) => h.id)).toEqual(msHits.map((h) => h.id))
    expect(frHits.length).toBeGreaterThan(0)
  })

  test('default: binary round-trip preserves upstream parity', () => {
    const { ms, fr } = buildIndexingPair(defaultDocs, defaultOptions)
    const buf = fr.saveBinarySync()
    const loaded = FrozenMiniSearch.loadBinarySync(buf, defaultOptions)
    expectSameIndexFingerprint(ms.toJSON(), loaded.toJSON())
    for (const query of ['zen', 'neur']) {
      expectSameResults(ms, loaded, query, defaultOptions.searchOptions)
    }
  })

  test('vocs: fromJson path preserves upstream parity', () => {
    const profile = indexingProfiles.find((p) => p.name === 'vocs')
    const { ms } = buildIndexingPair(profile.docs, profile.options)
    const loaded = FrozenMiniSearch.fromJson(JSON.stringify(ms.toJSON()), profile.options)
    expectSameIndexFingerprint(ms.toJSON(), loaded.toJSON())
    for (const query of ['configuration', 'create']) {
      expectSameResults(ms, loaded, query, profile.options.searchOptions, { scorePrecision: 5 })
    }
  })
})
