import MiniSearch from './MiniSearch'
import FrozenMiniSearch, { frozenMemoryBreakdown } from './FrozenMiniSearch'
import { createFrozenIndexBuilder } from './frozenBuild'
import { freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { overflowFrequencies } from '../benchmarks/benchmarkScenarios.js'

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

function buildFrozenViaFreeze () {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  return mutable.freeze()
}

function buildFrozenDirect () {
  return FrozenMiniSearch.fromDocuments(docs, options)
}

describe('FrozenMiniSearch.fromDocuments', () => {
  test('parity with freeze on standard corpus', () => {
    const frozen = buildFrozenViaFreeze()
    const direct = buildFrozenDirect()
    expect(direct.documentCount).toBe(frozen.documentCount)
    expect(direct.termCount).toBe(frozen.termCount)
    expectSameResults(frozen, direct, 'zen')
    expectSameResults(frozen, direct, 'zen whale', { combineWith: 'OR' })
    expectSameResults(frozen, direct, 'neur', { prefix: true })
    expectSameResults(frozen, direct, MiniSearch.wildcard)
    expect(direct.autoSuggest('zen ar')).toEqual(frozen.autoSuggest('zen ar'))
  })

  test('optional field null matches freeze BM25', () => {
    const sparseDocs = [
      { id: 1, title: 'alpha beta', text: 'one two' },
      { id: 2, title: null, text: 'three four' },
      { id: 3, title: 'gamma', text: 'five six' }
    ]
    const sparseOpts = { fields: ['title', 'text'] }
    const mutable = new MiniSearch(sparseOpts)
    mutable.addAll(sparseDocs)
    const frozen = mutable.freeze()
    const direct = FrozenMiniSearch.fromDocuments(sparseDocs, sparseOpts)
    expectSameResults(frozen, direct, 'three')
    expectSameResults(frozen, direct, 'alpha gamma', { combineWith: 'OR' })
  })

  test('processTerm returning array', () => {
    const corpus = [{ id: 1, text: 'FooBar' }]
    const opts = {
      fields: ['text'],
      processTerm: (term) => [term.toLowerCase(), term.toUpperCase()]
    }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = mutable.freeze()
    const direct = FrozenMiniSearch.fromDocuments(corpus, opts)
    expectSameResults(frozen, direct, 'foo')
    expectSameResults(frozen, direct, 'BAR')
  })

  test('processTerm array keeps empty-string entries like freeze', () => {
    const corpus = [{ id: 1, text: 'FooBar' }]
    const opts = {
      fields: ['text'],
      processTerm: () => ['', 'foo']
    }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = mutable.freeze()
    const direct = FrozenMiniSearch.fromDocuments(corpus, opts)
    expect(direct.termCount).toBe(frozen.termCount)
    expect(direct.search('foo')).toEqual(frozen.search('foo'))
  })

  test('overflow frequencies parity with freeze', () => {
    const corpus = overflowFrequencies(40, 400)
    const opts = { fields: ['txt'] }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = mutable.freeze()
    const direct = FrozenMiniSearch.fromDocuments(corpus, opts)
    const a = frozen.search('alpha', { combineWith: 'OR' })
    const b = direct.search('alpha', { combineWith: 'OR' })
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) {
      expect(b[i].id).toBe(a[i].id)
      expect(b[i].score).toBeCloseTo(a[i].score, 10)
    }
  })

  test('binary round-trip after fromDocuments', () => {
    const direct = buildFrozenDirect()
    const loaded = FrozenMiniSearch.loadBinary(direct.saveBinary(), options)
    const frozen = buildFrozenViaFreeze()
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('rejects missing and duplicate IDs like MiniSearch', () => {
    expect(() => FrozenMiniSearch.fromDocuments([{ text: 'a' }], { fields: ['text'] }))
      .toThrow(/does not have ID/)
    expect(() => FrozenMiniSearch.fromDocuments([
      { id: 1, text: 'a' },
      { id: 1, text: 'b' }
    ], { fields: ['text'] }))
      .toThrow(/duplicate ID/)
  })

  test('read-only after fromDocuments', () => {
    const direct = buildFrozenDirect()
    expect(() => direct.add(docs[0])).toThrow(/read-only/i)
  })

  test('empty corpus', () => {
    const direct = FrozenMiniSearch.fromDocuments([], options)
    expect(direct.documentCount).toBe(0)
    expect(direct.search('zen')).toEqual([])
  })
})

function buildFrozenViaBuilder (corpus = docs, opts = options, hints) {
  const builder = createFrozenIndexBuilder(opts, hints)
  for (let i = 0; i < corpus.length; i++) {
    builder.add(corpus[i])
  }
  return freezeFrozenIndexBuilder(builder)
}

describe('FrozenIndexBuilder', () => {
  test('parity with fromDocuments on standard corpus', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder()
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expect(fromBuilder.termCount).toBe(fromDocs.termCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
    expectSameResults(fromDocs, fromBuilder, 'zen whale', { combineWith: 'OR' })
    expect(fromBuilder.autoSuggest('zen ar')).toEqual(fromDocs.autoSuggest('zen ar'))
  })

  test('parity without estimatedDocumentCount hint', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder(docs, options, undefined)
    expectSameResults(fromDocs, fromBuilder, 'zen')
  })

  test('parity with underestimated estimatedDocumentCount', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder(docs, options, { estimatedDocumentCount: 1 })
    expectSameResults(fromDocs, fromBuilder, 'neur', { prefix: true })
  })

  test('parity and correct sizes with overestimated estimatedDocumentCount', () => {
    const fromDocs = buildFrozenDirect()
    const fromBuilder = buildFrozenViaBuilder(docs, options, { estimatedDocumentCount: docs.length + 100 })
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
    // Internal arrays must not be padded to the overestimate
    const breakdown = fromBuilder.memoryBreakdown()
    const directBreakdown = fromDocs.memoryBreakdown()
    expect(breakdown.documentCount).toBe(directBreakdown.documentCount)
    expect(breakdown.storedFieldsJsonBytes).toBe(directBreakdown.storedFieldsJsonBytes)
  })

  test('binary round-trip after builder freeze', () => {
    const built = buildFrozenViaBuilder()
    const loaded = FrozenMiniSearch.loadBinary(built.saveBinary(), options)
    const fromDocs = buildFrozenDirect()
    expect(loaded.search('zen')).toEqual(fromDocs.search('zen'))
  })

  test('empty index via freeze without add', () => {
    const empty = freezeFrozenIndexBuilder(createFrozenIndexBuilder(options))
    expect(empty.documentCount).toBe(0)
    expect(empty.search('zen')).toEqual([])
  })

  test('cannot add after freeze', () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    expect(() => builder.add(docs[1])).toThrow(/cannot add after freezeParams/i)
  })

  test('cannot freeze twice', () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    expect(() => builder.freezeParams()).toThrow(/freezeParams\(\) already called/i)
  })

  test('rejects duplicate ID like fromDocuments', () => {
    const builder = createFrozenIndexBuilder({ fields: ['text'] })
    builder.add({ id: 1, text: 'a' })
    expect(() => builder.add({ id: 1, text: 'b' })).toThrow(/duplicate ID/)
  })
})

describe('FrozenMiniSearch.fromAsyncIterable', () => {
  test('parity with fromDocuments', async () => {
    async function * docStream () {
      for (const doc of docs) yield doc
    }
    const fromDocs = buildFrozenDirect()
    const fromAsync = await FrozenMiniSearch.fromAsyncIterable(docStream(), options)
    expect(fromAsync.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromAsync, 'zen')
    expectSameResults(fromDocs, fromAsync, 'zen art', { combineWith: 'AND' })
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
