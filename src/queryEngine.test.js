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
