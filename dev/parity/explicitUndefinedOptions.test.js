import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'

/**
 * MiniSearch merges options with object spread, so a key passed explicitly as
 * `undefined` (or `null`) overrides the index-level value instead of inheriting it.
 * Any fixed-shape rewrite of the option merge must keep that behaviour.
 */
const docs = [
  { id: 1, title: 'moby dick', text: 'call me ishmael whale' },
  { id: 2, title: 'zen and the art', text: 'motorcycle maintenance moby' },
  { id: 3, title: 'neuromancer', text: 'the sky above the port whales' },
  { id: 4, title: 'whale song', text: 'art of zen mobile' },
]

const cases = [
  ['prefix: undefined', { prefix: true }, { prefix: undefined }, 'mob'],
  ['prefix: null', { prefix: true }, { prefix: null }, 'mob'],
  ['fuzzy: undefined', { fuzzy: 0.3 }, { fuzzy: undefined }, 'whal'],
  ['fields: undefined', { fields: ['title'] }, { fields: undefined }, 'moby'],
  ['combineWith: undefined', { combineWith: 'AND' }, { combineWith: undefined }, 'zen whale'],
  ['boostTerm: undefined', { boostTerm: () => 5 }, { boostTerm: undefined }, 'zen'],
  ['filter: undefined', { filter: (r) => r.id === 1 }, { filter: undefined }, 'moby'],
  [
    'boostDocument: undefined',
    { boostDocument: (id) => (id === 1 ? 0 : 1) },
    { boostDocument: undefined },
    'moby',
  ],
  [
    'nested combineWith: undefined',
    { combineWith: 'AND' },
    { combineWith: undefined },
    { combineWith: 'OR', queries: ['zen whale', { queries: ['art', 'moby'], combineWith: undefined }] },
  ],
]

function engines(searchOptions) {
  const options = { fields: ['title', 'text'], searchOptions }
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  return { mutable, frozen: FrozenMiniSearch.fromDocuments(docs, options) }
}

const scored = (results) => results.map((r) => [r.id, r.score])

describe('explicitly undefined search options match MiniSearch', () => {
  test.each(cases)('search with %s', (_name, searchOptions, local, query) => {
    const { mutable, frozen } = engines(searchOptions)
    const expected = scored(mutable.search(query, local))
    const actual = scored(frozen.search(query, local))
    expect(actual.map(([id]) => id)).toEqual(expected.map(([id]) => id))
    actual.forEach(([, score], i) => expect(score).toBeCloseTo(expected[i][1], 10))
  })

  test('autoSuggest with prefix: undefined drops the default last-term prefix', () => {
    const { mutable, frozen } = engines({ prefix: false })
    const expected = mutable.autoSuggest('mob', { prefix: undefined })
    expect(frozen.autoSuggest('mob', { prefix: undefined }).map((s) => s.suggestion)).toEqual(
      expected.map((s) => s.suggestion),
    )
  })
})
