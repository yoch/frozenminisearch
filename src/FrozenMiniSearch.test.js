import MiniSearch from './MiniSearch'
import FrozenMiniSearch, { frozenMemoryBreakdown, freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { createFrozenIndexBuilder } from './frozenBuild'
import { overflowFrequencies } from '../benchmarks/benchmarkScenarios.js'

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

function buildEngines() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = mutable.freeze()
  return { mutable, frozen }
}

function expectSameResults(mutable, frozen, query, searchOptions = {}) {
  const a = mutable.search(query, searchOptions)
  const b = frozen.search(query, searchOptions)
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) {
    expect(b[i].id).toBe(a[i].id)
    // toBeCloseTo rather than toBe because FrozenMiniSearch stores avgFieldLength as
    // Float32Array while MiniSearch uses Float64.  For most corpus values the
    // representations are identical, but after discard() (without vacuum) the
    // updated average can be an irrational fraction (e.g. 13/3) that has a tiny
    // Float32 vs Float64 rounding gap.  Precision 6 (|Δ| < 5e-7) is tight enough
    // to catch any real scoring regression.
    expect(b[i].score).toBeCloseTo(a[i].score, 6)
    expect(b[i].terms).toEqual(a[i].terms)
    expect(b[i].match).toEqual(a[i].match)
    const { score, terms, match, id, queryTerms, ...storedA } = a[i]
    const { score: _s, terms: _t, match: _m, id: _i, queryTerms: _q, ...storedB } = b[i]
    expect(storedB).toEqual(storedA)
  }
}

describe('FrozenMiniSearch parity with MiniSearch', () => {
  let mutable
  let frozen

  beforeEach(() => {
    ({ mutable, frozen } = buildEngines())
  })

  test('shared query engine: freeze, fromDocuments, and builder agree', () => {
    const viaFreeze = buildFrozenViaFreeze()
    const viaDocs = buildFrozenDirect()
    const viaBuilder = buildFrozenViaBuilder()
    const queries = [
      'zen',
      'zen whale',
      { combineWith: 'AND', queries: ['zen', 'art'] },
      'neur',
      MiniSearch.wildcard,
    ]
    const searchOpts = [
      {},
      { combineWith: 'OR' },
      { prefix: true },
      { fuzzy: 0.3 },
      { boost: { title: 2 } },
      { filter: r => r.category === 'fiction' },
    ]
    for (const q of queries) {
      for (const opts of searchOpts) {
        expectSameResults(viaFreeze, viaDocs, q, opts)
        expectSameResults(viaFreeze, viaBuilder, q, opts)
      }
    }
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
    const filter = r => r.category === 'fiction'
    expectSameResults(mutable, frozen, 'zen', { filter })
  })

  test('boostDocument', () => {
    const boostDocument = id => (id === 2 ? 2 : 1)
    expectSameResults(mutable, frozen, 'zen', { boostDocument })
  })

  test('nested query', () => {
    expectSameResults(mutable, frozen, {
      combineWith: 'AND',
      queries: ['zen', { combineWith: 'OR', queries: ['motorcycle', 'archery'] }],
    })
  })

  test('AND_NOT combine', () => {
    expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND_NOT' })
  })

  test('field boost', () => {
    expectSameResults(mutable, frozen, 'zen', { boost: { title: 2 } })
  })

  test('autoSuggest parity', () => {
    const a = mutable.autoSuggest('zen ar')
    const b = frozen.autoSuggest('zen ar')
    expect(b).toEqual(a)
  })

  test('has and getStoredFields', () => {
    expect(frozen.has(1)).toBe(true)
    expect(frozen.has(999)).toBe(false)
    expect(frozen.getStoredFields(3)).toEqual(mutable.getStoredFields(3))
  })

  test.each([
    ['add', idx => idx.add(docs[0])],
    ['addAll', idx => idx.addAll(docs)],
    ['addAllAsync', idx => idx.addAllAsync(docs)],
    ['remove', idx => idx.remove(docs[0])],
    ['removeAll', idx => idx.removeAll(docs)],
    ['discard', idx => idx.discard(1)],
    ['discardAll', idx => idx.discardAll([1, 2])],
    ['replace', idx => idx.replace(docs[0])],
    ['vacuum', idx => idx.vacuum()],
  ])('read-only mutation %s throws', (_label, mutate) => {
    expect(() => mutate(frozen)).toThrow(/read-only/i)
  })

  test('boostTerm parity', () => {
    const boostTerm = term => (term === 'zen' ? 2 : 1)
    expectSameResults(mutable, frozen, 'zen art', { boostTerm })
  })

  test('fields restriction parity', () => {
    expectSameResults(mutable, frozen, 'zen', { fields: ['title'] })
  })

  test('search tokenize and processTerm parity', () => {
    const tokenize = q => q.split(/\s+/)
    const processTerm = t => t.toLowerCase()
    expectSameResults(mutable, frozen, 'ZEN Art', { tokenize, processTerm })
  })

  test('explicit weights parity', () => {
    expectSameResults(mutable, frozen, 'neur', {
      prefix: true,
      weights: { fuzzy: 0.5, prefix: 0.4 },
    })
  })

  test('explicit bm25 parity', () => {
    expectSameResults(mutable, frozen, 'zen', {
      bm25: { k: 1.5, b: 0.6, d: 0.4 },
    })
  })
})

describe('FrozenMiniSearch custom indexing options', () => {
  test('custom idField and extractField parity', () => {
    const customDocs = [
      { key: 'a', body: 'hello world' },
      { key: 'b', body: 'hello again' },
    ]
    const customOpts = {
      fields: ['body'],
      idField: 'key',
      extractField: (doc, field) => doc[field],
    }
    const mutable = new MiniSearch(customOpts)
    mutable.addAll(customDocs)
    const frozen = mutable.freeze()
    const direct = FrozenMiniSearch.fromDocuments(customDocs, customOpts)
    expectSameResults(frozen, direct, 'hello')
  })

  test('custom stringifyField parity', () => {
    const customDocs = [{ id: 1, tags: ['alpha', 'beta'] }]
    const customOpts = {
      fields: ['tags'],
      stringifyField: value => value.join(' '),
    }
    const mutable = new MiniSearch(customOpts)
    mutable.addAll(customDocs)
    const frozen = mutable.freeze()
    const direct = FrozenMiniSearch.fromDocuments(customDocs, customOpts)
    expectSameResults(frozen, direct, 'alpha')
  })
})

describe('FrozenMiniSearch freeze after discard', () => {
  test('search parity without vacuum', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    mutable.discard(3)
    const frozen = mutable.freeze()
    expectSameResults(mutable, frozen, 'zen')
    expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND' })
    expectSameResults(mutable, frozen, MiniSearch.wildcard)
  })

  test('binary round-trip after discard without vacuum', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    mutable.discard(3)
    const frozen = mutable.freeze()
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
    expect(loaded.search(MiniSearch.wildcard)).toEqual(frozen.search(MiniSearch.wildcard))
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

  test('loadBinary rejects fields not in snapshot', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = mutable.freeze().saveBinary()
    expect(() => FrozenMiniSearch.loadBinary(buf, { fields: ['title', 'missing'] }))
      .toThrow(/must match the indexed fields exactly/)
  })

  test('loadBinary rejects field subset', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = mutable.freeze().saveBinary()
    expect(() => FrozenMiniSearch.loadBinary(buf, { fields: ['title'] }))
      .toThrow(/must match the indexed fields exactly/)
  })

  test('overflow frequencies survive saveBinary round-trip', () => {
    const corpus = overflowFrequencies(40, 400)
    const opts = { fields: ['txt'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), opts)
    const before = frozen.search('alpha', { combineWith: 'OR' })
    const after = loaded.search('alpha', { combineWith: 'OR' })
    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].id).toBe(before[i].id)
      expect(after[i].score).toBeCloseTo(before[i].score, 10)
    }
  })

  test('saveBinary writes MSv4 for multi-field index', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = mutable.freeze().saveBinary()
    expect(buf.toString('ascii', 0, 4)).toBe('MSv4')
    expect(buf.readUInt16LE(4)).toBe(4)
  })

  test('saveBinary writes MSv3 for single-field Uint32 doc ids', () => {
    const docsBig = Array.from({ length: 70000 }, (_, i) => ({
      id: i,
      text: `hello world ${i}`,
    }))
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(docsBig)
    const buf = mutable.freeze().saveBinary()
    expect(buf.toString('ascii', 0, 4)).toBe('MSv3')
    expect(buf.readUInt16LE(4)).toBe(3)
  })

  test('loadBinary without fields option', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), {})
    expectSameResults(frozen, loaded, 'zen')
  })
})

function buildFrozenViaFreeze() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  return mutable.freeze()
}

function buildFrozenDirect() {
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
      { id: 3, title: 'gamma', text: 'five six' },
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
      processTerm: term => [term.toLowerCase(), term.toUpperCase()],
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
      processTerm: () => ['', 'foo'],
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
      { id: 1, text: 'b' },
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

function buildFrozenViaBuilder(corpus = docs, opts = options, hints) {
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
    async function* docStream() {
      for (const doc of docs) yield doc
    }
    const fromDocs = buildFrozenDirect()
    const fromAsync = await FrozenMiniSearch.fromAsyncIterable(docStream(), options)
    expect(fromAsync.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromAsync, 'zen')
    expectSameResults(fromDocs, fromAsync, 'zen art', { combineWith: 'AND' })
  })

  test('parity with estimatedDocumentCount hint', async () => {
    async function* docStream() {
      for (const doc of docs) yield doc
    }
    const fromDocs = buildFrozenDirect()
    const fromAsync = await FrozenMiniSearch.fromAsyncIterable(docStream(), options, {
      estimatedDocumentCount: docs.length,
    })
    expect(fromAsync.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromAsync, 'zen')
  })

  test('correct sizes with overestimated estimatedDocumentCount', async () => {
    async function* docStream() {
      for (const doc of docs) yield doc
    }
    const fromDocs = buildFrozenDirect()
    const fromAsync = await FrozenMiniSearch.fromAsyncIterable(docStream(), options, {
      estimatedDocumentCount: docs.length + 100,
    })
    expect(fromAsync.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromAsync, 'zen')
    const breakdown = fromAsync.memoryBreakdown()
    const directBreakdown = fromDocs.memoryBreakdown()
    expect(breakdown.documentCount).toBe(directBreakdown.documentCount)
    expect(breakdown.storedFieldsJsonBytes).toBe(directBreakdown.storedFieldsJsonBytes)
  })
})

describe('FrozenIndexBuilder.addAll / addAllAsync', () => {
  test('addAll parity with fromDocuments', () => {
    const fromDocs = buildFrozenDirect()
    const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: docs.length })
    builder.addAll(docs)
    const fromBuilder = freezeFrozenIndexBuilder(builder)
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
    expectSameResults(fromDocs, fromBuilder, 'zen art', { combineWith: 'AND' })
  })

  test('addAllAsync parity with fromDocuments', async () => {
    const fromDocs = buildFrozenDirect()
    const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: docs.length })
    await builder.addAllAsync(docs)
    const fromBuilder = freezeFrozenIndexBuilder(builder)
    expect(fromBuilder.documentCount).toBe(fromDocs.documentCount)
    expectSameResults(fromDocs, fromBuilder, 'zen')
  })

  test('addAllAsync accepts chunkSize option', async () => {
    const builder = createFrozenIndexBuilder(options)
    await builder.addAllAsync(docs, { chunkSize: 3 })
    const frozen = freezeFrozenIndexBuilder(builder)
    expect(frozen.documentCount).toBe(docs.length)
  })

  test('addAllAsync rejects non-positive chunkSize', () => {
    const builder = createFrozenIndexBuilder(options)
    expect(() => builder.addAllAsync(docs, { chunkSize: 0 }))
      .toThrow(/chunkSize must be a positive integer/)
    expect(() => builder.addAllAsync(docs, { chunkSize: -1 }))
      .toThrow(/chunkSize must be a positive integer/)
  })

  test('cannot addAll after freeze', () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    expect(() => builder.addAll([docs[1]])).toThrow(/cannot add after freezeParams/i)
  })

  test('cannot addAllAsync after freeze', async () => {
    const builder = createFrozenIndexBuilder(options)
    builder.add(docs[0])
    freezeFrozenIndexBuilder(builder)
    await expect(builder.addAllAsync([docs[1]])).rejects.toThrow(/cannot add after freezeParams/i)
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
    expect(b.radixTree.nodeCount).toBeGreaterThan(0)
    expect(b.estimatedStructuredBytes).toBeGreaterThan(0)
  })
})

describe('fieldLengthMatrix adaptive width', () => {
  test('uses Uint8 for typical multi-field corpus', () => {
    const frozen = buildFrozenDirect()
    const params = frozen.memoryBreakdown()
    // 4 docs × 2 fields × 1 byte
    expect(params.documents.fieldLengthMatrixBytes).toBe(8)
  })

  test('uses Uint16 when a field exceeds 255 unique terms', () => {
    const corpus = [{ id: 1, text: Array.from({ length: 300 }, (_, i) => `term${i}`).join(' ') }]
    const opts = { fields: ['text'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    expect(frozen.memoryBreakdown().documents.fieldLengthMatrixBytes).toBe(2)
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), opts)
    expect(loaded.search('term0')).toEqual(frozen.search('term0'))
    // Wire format is always Uint32 per cell; adaptive width is not preserved after load.
    expect(loaded.memoryBreakdown().documents.fieldLengthMatrixBytes).toBe(4)
  })

  test('uses Uint32 when a field exceeds 65535 unique terms', () => {
    const corpus = [{ id: 1, text: Array.from({ length: 70000 }, (_, i) => `term${i}`).join(' ') }]
    const opts = { fields: ['text'] }
    const frozen = FrozenMiniSearch.fromDocuments(corpus, opts)
    expect(frozen.memoryBreakdown().documents.fieldLengthMatrixBytes).toBe(4)
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), opts)
    expect(loaded.memoryBreakdown().documents.fieldLengthMatrixBytes).toBe(4)
    expect(loaded.search('term0')).toEqual(frozen.search('term0'))
  })

  test('freezeFromMiniSearch uses Uint32 for extreme field lengths', () => {
    const corpus = [{ id: 1, text: Array.from({ length: 70000 }, (_, i) => `term${i}`).join(' ') }]
    const opts = { fields: ['text'] }
    const mutable = new MiniSearch(opts)
    mutable.addAll(corpus)
    const frozen = mutable.freeze()
    expect(frozen.memoryBreakdown().documents.fieldLengthMatrixBytes).toBe(4)
  })

  test('saveBinary round-trip preserves search with Uint8 matrix', () => {
    const frozen = buildFrozenDirect()
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), options)
    expectSameResults(frozen, loaded, 'zen')
    expectSameResults(frozen, loaded, 'neur', { prefix: true })
  })

  test('freeze after discard keeps adaptive matrix', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    mutable.discard(3)
    const frozen = mutable.freeze()
    expect(frozen.memoryBreakdown().documents.fieldLengthMatrixBytes).toBe(6)
    expectSameResults(mutable, frozen, 'zen')
  })
})
