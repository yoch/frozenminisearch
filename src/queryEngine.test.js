import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenTermIndex } from './internal/frozenInternals'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance', category: 'fiction' },
  { id: 3, title: 'Neuromancer', text: 'cyberspace matrix hacker', category: 'sci-fi' },
  { id: 4, title: 'Zen Archery', text: 'zen archery art practice', category: 'non-fiction' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title', 'category'],
  searchOptions: { prefix: true, fuzzy: 0.2 },
}

describe('queryEngine error handling', () => {
  let frozen

  beforeEach(() => {
    frozen = FrozenMiniSearch.fromDocuments(docs, options)
  })

  test('rejects arbitrary Symbol as query', () => {
    expect(() => frozen.search(Symbol('*'))).toThrow(/invalid query/)
  })

  test('rejects non-query object', () => {
    expect(() => frozen.search({ notAQuery: true })).toThrow(/invalid query/)
  })

  test('rejects unknown combineWith on multi-branch combination', () => {
    expect(() => frozen.search({
      combineWith: 'bogus',
      queries: ['zen', 'art'],
    })).toThrow(/invalid combination operator/)
  })

  test('rejects unknown combineWith on nested combination', () => {
    expect(() => frozen.search({
      combineWith: 'AND',
      queries: [
        'zen',
        { combineWith: 'xor', queries: ['motorcycle', 'archery'] },
      ],
    })).toThrow(/invalid combination operator/)
  })

  test('single-term string still validates combineWith from searchOptions', () => {
    expect(() => frozen.search('zen', { combineWith: 'bogus' }))
      .toThrow(/invalid combination operator/)
  })
})

describe('queryEngine derived terms', () => {
  test('prefix and fuzzy match keys come from the traversal, not term-index metadata', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, options)
    const prefixHit = index.search('motor', { prefix: true, fuzzy: false }).find(r => r.id === 2)
    expect(prefixHit.match).toEqual({ motorcycle: ['title', 'text'] })
    const fuzzyHit = index.search('archeri', { prefix: false, fuzzy: 1 }).find(r => r.id === 4)
    expect(fuzzyHit.match).toEqual({ archery: ['title', 'text'] })
    expect(index.autoSuggest('zen ar').map(s => s.suggestion)).toContain('zen art')
    expect(frozenTermIndex(index)._lazyTermMetadata).toBeUndefined()
  })
})

describe('search limit', () => {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'alphabet', 'betamax', 'gammon']
  const corpus = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    text: `${words[i % 7]} ${words[(i * 3) % 7]} ${words[(i * 5) % 7]}`,
    group: i % 5,
  }))
  const corpusOptions = { fields: ['text'], storeFields: ['group'] }

  test.each([
    ['exact', 'alpha', {}],
    ['prefix', 'alp bet', { prefix: true }],
    ['fuzzy AND', 'gama delta', { fuzzy: 0.3, combineWith: 'AND' }],
    ['wildcard', FrozenMiniSearch.wildcard, {}],
    ['wildcard + boostDocument', FrozenMiniSearch.wildcard, { boostDocument: id => 1 + (id % 3) }],
    ['filter', 'alpha beta', { filter: r => r.group !== 2 }],
  ])('%s: limit equals slicing the full results', (_name, query, searchOptions) => {
    const index = FrozenMiniSearch.fromDocuments(corpus, corpusOptions)
    const full = index.search(query, searchOptions)
    expect(full.length).toBeGreaterThan(10)
    for (const limit of [0, 1, 3, 10, full.length - 1, full.length, full.length + 1]) {
      expect(index.search(query, { ...searchOptions, limit })).toEqual(full.slice(0, limit))
    }
  })

  test('index-level default limit applies and can be lifted per search', () => {
    const index = FrozenMiniSearch.fromDocuments(corpus, { ...corpusOptions, searchOptions: { limit: 5 } })
    expect(index.search('alpha')).toHaveLength(5)
    expect(index.search('alpha', { limit: Infinity }).length).toBeGreaterThan(5)
  })

  test('autoSuggest ignores limit', () => {
    const index = FrozenMiniSearch.fromDocuments(corpus, corpusOptions)
    const filter = r => r.group !== 1
    expect(index.autoSuggest('alp', { filter, limit: 1 })).toEqual(index.autoSuggest('alp', { filter }))
    expect(index.autoSuggest('alp', { limit: 1 })).toEqual(index.autoSuggest('alp'))
  })

  test('rejects invalid limits', () => {
    const index = FrozenMiniSearch.fromDocuments(corpus, corpusOptions)
    expect(() => index.search('alpha', { limit: -1 })).toThrow('limit must be a non-negative integer or Infinity')
  })
})
