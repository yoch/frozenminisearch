import FrozenMiniSearch from './FrozenMiniSearch'

/**
 * Contract of per-call search options against index-level `searchOptions`.
 *
 * An option passed as `undefined` or `null` inherits the index-level value. MiniSearch
 * merges with object spread instead, so there such a key clears the index-level value;
 * this is a deliberate divergence. `filter`, `boostDocument` and `limit` are the
 * exception: passing them explicitly as `undefined` disables the index-level value.
 */
const docs = [
  { id: 1, title: 'moby dick', text: 'call me ishmael whale' },
  { id: 2, title: 'zen and the art', text: 'motorcycle maintenance moby' },
  { id: 3, title: 'neuromancer', text: 'the sky above the port whales' },
  { id: 4, title: 'whale song', text: 'art of zen mobile' },
]

function index(searchOptions, autoSuggestOptions) {
  return FrozenMiniSearch.fromDocuments(docs, {
    fields: ['title', 'text'],
    searchOptions,
    autoSuggestOptions,
  })
}

const scored = (results) => results.map((r) => [r.id, r.score])

describe('per-call options left undefined or null inherit the index-level value', () => {
  const cases = [
    ['prefix', { prefix: true }, 'mob'],
    ['fuzzy', { fuzzy: 0.3 }, 'whal'],
    ['fields', { fields: ['title'] }, 'moby'],
    ['combineWith', { combineWith: 'AND' }, 'zen whale'],
    ['boostTerm', { boostTerm: () => 5 }, 'zen'],
    ['maxFuzzy', { fuzzy: 0.9, maxFuzzy: 1 }, 'whalx'],
    ['boost', { boost: { title: 3 } }, 'moby'],
    ['weights', { prefix: true, weights: { prefix: 0.9, fuzzy: 0.1 } }, 'mob'],
    ['bm25', { bm25: { k: 2, b: 0.5, d: 0.1 } }, 'moby'],
    ['tokenize', { tokenize: (text) => text.split('y') }, 'mobydick'],
    ['processTerm', { processTerm: (term) => term.slice(0, 4) }, 'mobyX'],
  ]

  test.each(cases)('%s', (name, searchOptions, query) => {
    const frozen = index(searchOptions)
    const inherited = scored(frozen.search(query))
    expect(inherited.length).toBeGreaterThan(0)
    // The index-level option changes the result, so inheriting it is observable.
    expect(scored(index({}).search(query))).not.toEqual(inherited)
    for (const empty of [undefined, null]) {
      expect(scored(frozen.search(query, { [name]: empty }))).toEqual(inherited)
      expect(
        scored(frozen.searchPage(query, { [name]: empty, limit: 10 }).results),
      ).toEqual(inherited)
      expect(frozen.matchIds(query, { [name]: empty }).sort()).toEqual(
        inherited.map(([id]) => id).sort(),
      )
    }
  })

  test('a nested combination inherits combineWith from its parent', () => {
    const frozen = index({})
    const query = (inner) => ({
      combineWith: 'AND',
      queries: ['zen', { queries: ['art', 'whale'], ...inner }],
    })
    const inherited = scored(frozen.search(query({})))
    expect(scored(frozen.search(query({ combineWith: undefined })))).toEqual(
      inherited,
    )
    expect(scored(frozen.search(query({ combineWith: 'OR' })))).not.toEqual(
      inherited,
    )
  })

  test('autoSuggest keeps its default last-term prefix', () => {
    const frozen = index({ prefix: false })
    const inherited = frozen.autoSuggest('mob').map((s) => s.suggestion)
    expect(inherited.length).toBeGreaterThan(0)
    expect(
      frozen.autoSuggest('mob', { prefix: undefined }).map((s) => s.suggestion),
    ).toEqual(inherited)
  })
})

describe('filter, boostDocument and limit passed as undefined disable the index-level value', () => {
  test('filter', () => {
    const frozen = index({ filter: (result) => result.id === 1 })
    expect(frozen.search('moby').map((r) => r.id)).toEqual([1])
    expect(scored(frozen.search('moby', { filter: undefined }))).toEqual(
      scored(index({}).search('moby')),
    )
    expect(frozen.matchIds('moby', { filter: undefined }).sort()).toEqual([
      1, 2,
    ])
    expect(
      frozen.autoSuggest('mob', { filter: undefined }).map((s) => s.suggestion),
    ).toEqual(
      index({})
        .autoSuggest('mob')
        .map((s) => s.suggestion),
    )
  })

  test('boostDocument', () => {
    const frozen = index({ boostDocument: (id) => (id === 1 ? 0 : 1) })
    expect(frozen.search('moby').map((r) => r.id)).toEqual([2])
    expect(scored(frozen.search('moby', { boostDocument: undefined }))).toEqual(
      scored(index({}).search('moby')),
    )
  })

  test('limit', () => {
    const frozen = index({ limit: 1 })
    expect(frozen.search('moby')).toHaveLength(1)
    expect(frozen.search('moby', { limit: undefined })).toHaveLength(2)
  })

  test('an absent key still inherits', () => {
    const frozen = index({ filter: (result) => result.id === 1, limit: 1 })
    expect(frozen.search('moby', {}).map((r) => r.id)).toEqual([1])
    expect(frozen.search('moby', { prefix: true }).map((r) => r.id)).toEqual([
      1,
    ])
  })
})
