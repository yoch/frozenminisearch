import MiniSearch from 'minisearch'
import FrozenMiniSearch, { freezeFrozenIndexBuilder } from '../../src/FrozenMiniSearch'
import { createFrozenIndexBuilder } from '../../src/frozenBuild'
import { expectSameResults } from './parityHarness.js'
import { expectSameIndexFingerprint } from '../../testSupport/indexFingerprint.js'
import {
  camelCaseOptions,
  indexingProfiles,
} from '../../testSupport/indexingProfiles.js'

function buildIndexingPair (docs, options) {
  const ms = new MiniSearch(options)
  ms.addAll(docs)
  const fr = FrozenMiniSearch.fromDocuments(docs, options)
  return { ms, fr }
}

function buildMutable (docs, options) {
  const ms = new MiniSearch(options)
  ms.addAll(docs)
  return ms
}

function buildFrozenWithBuilder (docs, options) {
  const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: docs.length })
  builder.addAll(docs)
  return freezeFrozenIndexBuilder(builder)
}

function scorePrecisionForProfile (profile) {
  return profile.name === 'vocs' ? 5 : 6
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
      const scorePrecision = scorePrecisionForProfile(profile)
      expectUpstreamIndexingParity(ms, fr, profile.options, profile.queries, { scorePrecision })
    },
  )

  test.each(indexingProfiles.map((p) => [p.name, p]))(
    'profile %s: builder addAll matches upstream',
    (_name, profile) => {
      const ms = buildMutable(profile.docs, profile.options)
      const fr = buildFrozenWithBuilder(profile.docs, profile.options)
      expectUpstreamIndexingParity(ms, fr, profile.options, profile.queries, {
        scorePrecision: scorePrecisionForProfile(profile),
      })
    },
  )

  test.each(indexingProfiles.map((p) => [p.name, p]))(
    'profile %s: fromJson upstream snapshot matches upstream',
    (_name, profile) => {
      const ms = buildMutable(profile.docs, profile.options)
      const loaded = FrozenMiniSearch.fromJson(JSON.stringify(ms.toJSON()), profile.options)
      expectUpstreamIndexingParity(ms, loaded, profile.options, profile.queries, {
        scorePrecision: scorePrecisionForProfile(profile),
      })
    },
  )

  test.each(indexingProfiles.map((p) => [p.name, p]))(
    'profile %s: binary round-trip preserves upstream parity',
    (_name, profile) => {
      const { ms, fr } = buildIndexingPair(profile.docs, profile.options)
      const loaded = FrozenMiniSearch.loadBinarySync(fr.saveBinarySync(), profile.options)
      expectUpstreamIndexingParity(ms, loaded, profile.options, profile.queries, {
        scorePrecision: scorePrecisionForProfile(profile),
      })
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
})
