import MiniSearch from './MiniSearch'
import FrozenMiniSearch, { frozenMemoryBreakdown } from './FrozenMiniSearch'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance', category: 'fiction' },
  { id: 3, title: 'Neuromancer', text: 'cyberspace matrix hacker', category: 'sci-fi' },
  { id: 4, title: 'Zen Archery', text: 'zen archery art practice', category: 'non-fiction' }
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title', 'category'],
  searchOptions: { prefix: true, fuzzy: 0.2 }
}

function buildEngines () {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = mutable.freeze()
  return { mutable, frozen }
}

function expectSameResults (mutable, frozen, query, searchOptions = {}) {
  const a = mutable.search(query, searchOptions)
  const b = frozen.search(query, searchOptions)
  expect(b).toEqual(a)
}

describe('FrozenMiniSearch parity with MiniSearch', () => {
  let mutable
  let frozen

  beforeEach(() => {
    ({ mutable, frozen } = buildEngines())
  })

  test('exact search', () => {
    expectSameResults(mutable, frozen, 'zen')
  })

  test('OR combine', () => {
    expectSameResults(mutable, frozen, 'zen whale', { combineWith: 'OR' })
  })

  test('AND combine', () => {
    expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND' })
  })

  test('prefix search', () => {
    expectSameResults(mutable, frozen, 'neur', { prefix: true })
  })

  test('fuzzy search', () => {
    expectSameResults(mutable, frozen, 'neuromancr', { fuzzy: 0.3 })
  })

  test('wildcard', () => {
    expectSameResults(mutable, frozen, MiniSearch.wildcard)
  })

  test('filter', () => {
    const filter = (r) => r.category === 'fiction'
    expectSameResults(mutable, frozen, 'zen', { filter })
  })

  test('boostDocument', () => {
    const boostDocument = (id) => (id === 2 ? 2 : 1)
    expectSameResults(mutable, frozen, 'zen', { boostDocument })
  })

  test('nested query', () => {
    expectSameResults(mutable, frozen, {
      combineWith: 'AND',
      queries: ['zen', { combineWith: 'OR', queries: ['motorcycle', 'archery'] }]
    })
  })

  test('AND_NOT combine', () => {
    expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND_NOT' })
  })

  test('field boost', () => {
    expectSameResults(mutable, frozen, 'zen', { boost: { title: 2 } })
  })

  test('autoSuggest parity', () => {
    const suggestOptions = { ...options.autoSuggestOptions }
    expectSameResults(mutable, frozen, 'zen ar', suggestOptions)
    const a = mutable.autoSuggest('zen ar')
    const b = frozen.autoSuggest('zen ar')
    expect(b).toEqual(a)
  })

  test('has and getStoredFields', () => {
    expect(frozen.has(1)).toBe(true)
    expect(frozen.has(999)).toBe(false)
    expect(frozen.getStoredFields(3)).toEqual(mutable.getStoredFields(3))
  })

  test('read-only mutations throw', () => {
    expect(() => frozen.add(docs[0])).toThrow(/read-only/i)
    expect(() => frozen.remove(docs[0])).toThrow(/read-only/i)
    expect(() => frozen.discard(1)).toThrow(/read-only/i)
  })
})

describe('FrozenMiniSearch binary round-trip', () => {
  test('search results match after saveBinary/loadBinary', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    const buf = frozen.saveBinary()
    const loaded = FrozenMiniSearch.loadBinary(buf, options)

    expect(loaded.search('zen motorcycle')).toEqual(frozen.search('zen motorcycle'))
    expect(loaded.search('neur', { prefix: true })).toEqual(frozen.search('neur', { prefix: true }))
    expect(loaded.documentCount).toBe(frozen.documentCount)
    expect(loaded.termCount).toBe(frozen.termCount)
  })

  test('autoSuggest keeps defaults and ordering after saveBinary/loadBinary', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), options)

    expect(loaded.autoSuggest('zen ar')).toEqual(frozen.autoSuggest('zen ar'))
  })

  test('loadBinary rejects unknown fields', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = mutable.freeze().saveBinary()
    expect(() => FrozenMiniSearch.loadBinary(buf, { fields: ['title', 'missing'] }))
      .toThrow(/field "missing" not found/)
  })

  test('saveBinary writes MSv2 format', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = mutable.freeze().saveBinary()
    expect(buf.toString('ascii', 0, 4)).toBe('MSv2')
    expect(buf.readUInt16LE(4)).toBe(2)
  })
})

describe('frozenMemoryBreakdown', () => {
  test('returns sensible structure sizes', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    const b = frozenMemoryBreakdown(frozen)
    expect(b.termCount).toBeGreaterThan(0)
    expect(b.postings.totalTypedBytes).toBeGreaterThan(0)
    expect(b.radixTree.mapNodeCount).toBeGreaterThan(0)
    expect(b.estimatedStructuredBytes).toBeGreaterThan(0)
  })
})
