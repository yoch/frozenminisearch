import FrozenMiniSearch from './FrozenMiniSearch'

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

describe('queryEngine re-entered from callbacks', () => {
  const outerQueries = [
    ['exact', 'zen art', {}],
    ['prefix', 'zen mot', { prefix: true, fuzzy: false }],
    ['fuzzy', 'zen archeri', { prefix: false, fuzzy: 0.3 }],
    ['AND', 'zen art', { combineWith: 'AND' }],
    ['AND_NOT', 'zen motorcycle', { combineWith: 'AND_NOT' }],
    ['nested combination', { combineWith: 'OR', queries: ['zen', { combineWith: 'AND', queries: ['art', 'arch'] }] }, { prefix: true }],
    ['wildcard', FrozenMiniSearch.wildcard, {}],
  ]
  const reentries = [
    ['search', index => index.search('cyber arch whale', { prefix: true, fuzzy: 0.3 })],
    ['autoSuggest', index => index.autoSuggest('mat hack')],
    ['toJSON', index => index.toJSON()],
    ['nested boostDocument search', index => index.search('ishmael sea', {
      boostDocument: () => {
        index.search('matrix', { prefix: true })
        return 1
      },
    })],
  ]

  describe.each(outerQueries)('%s', (_name, query, searchOptions) => {
    test.each(reentries)('matches a non-reentrant run when boostDocument calls %s', (_reentry, reenter) => {
      const index = FrozenMiniSearch.fromDocuments(docs, options)
      const boost = id => (id % 2) + 1
      const expected = index.search(query, { ...searchOptions, boostDocument: boost })
      expect(expected.length).toBeGreaterThan(0)
      const actual = index.search(query, {
        ...searchOptions,
        boostDocument: (id) => {
          reenter(index)
          return boost(id)
        },
      })
      expect(actual).toEqual(expected)
    })
  })

  test('autoSuggest and filter callbacks may search the same index', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, options)
    const expectedSuggestions = index.autoSuggest('zen ar', { boostDocument: () => 1 })
    expect(index.autoSuggest('zen ar', {
      boostDocument: () => {
        index.search('neuromancer hacker')
        return 1
      },
    })).toEqual(expectedSuggestions)

    const expected = index.search('zen art', { filter: r => r.category === 'fiction' })
    expect(index.search('zen art', {
      filter: (r) => {
        index.search('cyber whale', { prefix: true })
        return r.category === 'fiction'
      },
    })).toEqual(expected)
  })

  test('a throwing nested search leaves the index usable', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, options)
    const expected = index.search('zen mot')
    expect(() => index.search('zen', {
      boostDocument: () => {
        index.search('zen', { combineWith: 'bogus' })
        return 1
      },
    })).toThrow(/invalid combination operator/)
    expect(index._activeQueries).toBe(0)
    expect(index.search('zen mot')).toEqual(expected)
  })
})
