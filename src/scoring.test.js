import { SegmentPostingList } from './compactPostings'
import {
  AND,
  AND_NOT,
  OR,
  aggregateTerm,
  calcBM25Score,
  collectDocIdsFromFieldTermData,
  combineResults,
  defaultBM25params,
  finalizeRawSearchResults,
  finalizeSearchResults,
  finalizeSearchPage,
} from './scoring'
import { defaultSearchOptions } from './searchDefaults'

function mapPostingList(freqs) {
  return {
    get size() { return freqs.size },
    forEachDoc(callback) {
      for (const [docId, termFreq] of freqs) {
        callback(docId, termFreq)
      }
    },
  }
}

function mapFieldTermData(data) {
  return {
    get(fieldId) {
      const freqs = data.get(fieldId)
      return freqs == null ? undefined : mapPostingList(freqs)
    },
  }
}

function makeContext(overrides = {}) {
  return {
    documentCount: 4,
    avgFieldLength: [10],
    fieldIds: { text: 0 },
    getFieldLength: () => 5,
    getExternalId: docId => docId,
    getStoredFields: () => undefined,
    ...overrides,
  }
}

const fieldBoosts = { names: ['text'], boosts: { text: 1 } }

function mapPostings(fieldId, postings) {
  const byField = new Map([[fieldId, new Map(postings)]])
  return mapFieldTermData(byField)
}

describe('BM25 IDF hoist parity', () => {
  test('calcBM25Score matches reference inputs after TF/IDF split', () => {
    const params = defaultBM25params
    const totalCount = 10_000
    const matchingCount = 500
    const avgFieldLength = 12.5
    const samples = [
      { termFreq: 1, fieldLength: 8 },
      { termFreq: 3, fieldLength: 20 },
      { termFreq: 15, fieldLength: 4 },
    ]
    for (const { termFreq, fieldLength } of samples) {
      const score = calcBM25Score(
        termFreq, matchingCount, totalCount, fieldLength, avgFieldLength, params,
      )
      expect(Number.isFinite(score)).toBe(true)
      expect(score).toBeGreaterThan(0)
    }
  })
})

describe('combineResults', () => {
  function makeOperands() {
    const a = new Map([
      [0, { score: 2, terms: ['a'], match: { a: ['text'] } }],
      [1, { score: 1, terms: ['a'], match: { a: ['text'] } }],
    ])
    const b = new Map([
      [1, { score: 3, terms: ['b'], match: { b: ['text'] } }],
      [2, { score: 4, terms: ['b'], match: { b: ['text'] } }],
    ])
    return { a, b }
  }

  test('OR merges scores and match info', () => {
    const { a, b } = makeOperands()
    const merged = combineResults([a, b], OR)
    expect(merged.get(0)?.score).toBe(2)
    expect(merged.get(1)?.score).toBe(4)
    expect(merged.get(2)?.score).toBe(4)
    expect(merged.get(1)?.terms.sort()).toEqual(['a', 'b'])
  })

  test('AND keeps only shared doc ids and sums scores', () => {
    const { a, b } = makeOperands()
    const merged = combineResults([a, b], AND)
    expect(Array.from(merged.keys())).toEqual([1])
    expect(merged.get(1)?.score).toBe(4)
    expect(merged.get(1)?.terms.sort()).toEqual(['a', 'b'])
  })

  test('AND_NOT removes docs present in the right operand', () => {
    const { a, b } = makeOperands()
    const merged = combineResults([a, b], AND_NOT)
    expect(Array.from(merged.keys())).toEqual([0])
    expect(merged.get(0)?.score).toBe(2)
  })

  test.each(['xor', 'constructor', '__proto__', 'hasOwnProperty'])('rejects invalid combination operator %s', (operator) => {
    const { a, b } = makeOperands()
    expect(() => combineResults([a, b], operator)).toThrow(/invalid combination operator/)
  })

  test('returns empty map for empty operand list', () => {
    expect(combineResults([], OR)).toEqual(new Map())
    expect(combineResults([], AND)).toEqual(new Map())
    expect(combineResults([], AND_NOT)).toEqual(new Map())
  })

  test('returns the sole operand for single-result combinations after operator validation', () => {
    const single = new Map([[1, { score: 1, terms: ['a'], match: { a: ['text'] } }]])
    expect(combineResults([single], OR)).toBe(single)
    expect(() => combineResults([single], 'xor')).toThrow(/invalid combination operator/)
  })
})

describe('aggregateTerm', () => {
  test('scores only allowed docs when gate is smaller than posting list', () => {
    const fieldTermData = mapPostings(0, [[0, 2], [1, 1], [2, 1], [3, 1]])
    const allowedDocs = new Set([1, 3])
    const results = aggregateTerm(
      'alpha', 'alpha', 1, 1,
      fieldTermData, fieldBoosts, makeContext(),
      undefined, defaultBM25params, new Map(),
      { allowedDocs },
    )
    expect(Array.from(results.keys()).sort()).toEqual([1, 3])
  })

  test('excludes docs when boostDocumentFn returns 0', () => {
    const fieldTermData = mapPostings(0, [[0, 1], [1, 2]])
    const results = aggregateTerm(
      'gamma', 'gamma', 1, 1,
      fieldTermData, fieldBoosts, makeContext(),
      () => 0, defaultBM25params,
    )
    expect(results.size).toBe(0)
  })

  test('resolves cursor derived terms once per posting list', () => {
    let resolves = 0
    const cursor = {
      term() {
        resolves += 1
        return 'derived'
      },
    }
    const fieldTermData = mapPostings(0, [[0, 1], [1, 1]])
    const results = aggregateTerm(
      'src', cursor,
      1, 1,
      fieldTermData,
      fieldBoosts,
      makeContext(),
      undefined, defaultBM25params,
    )
    expect(results.get(0)?.match.derived).toEqual(['text'])
    expect(results.get(1)?.match.derived).toEqual(['text'])
    expect(resolves).toBe(1)
  })

  test.each([
    ['map postings', mapPostings(0, [[0, 1], [1, 3]])],
    ['segment postings', {
      get: fieldId => (fieldId === 0 ? new SegmentPostingList(new Uint32Array([0, 1]), new Uint8Array([1, 3]), 0, 2) : undefined),
    }],
  ])('without match tracking, keeps scores and query terms and skips derived terms (%s)', (_name, fieldTermData) => {
    let resolves = 0
    const cursor = {
      term() {
        resolves += 1
        return 'derived'
      },
    }
    const run = (boostDocument, trackMatch) => aggregateTerm(
      'src', cursor, 0.5, 2,
      fieldTermData, fieldBoosts, makeContext(),
      boostDocument, defaultBM25params, new Map(), { trackMatch },
    )
    const full = run(undefined, true)
    resolves = 0
    const reduced = run(undefined, false)
    expect(resolves).toBe(0)
    expect(Array.from(reduced.keys())).toEqual(Array.from(full.keys()))
    for (const [docId, { score, terms, match }] of reduced) {
      expect(match).toBeUndefined()
      expect(terms).toEqual(['src'])
      expect(score).toBe(full.get(docId).score)
    }
    const boostedTerms = []
    const boosted = run((id, term) => {
      boostedTerms.push(term)
      return id === 0 ? 0 : 2
    }, false)
    expect(boostedTerms).toEqual(['derived', 'derived'])
    expect(Array.from(boosted.keys())).toEqual([1])
    expect(boosted.get(1).match).toBeUndefined()
  })

  test('combinators merge results without match information', () => {
    const left = () => new Map([[0, { score: 1, terms: ['a'], match: undefined }], [1, { score: 2, terms: ['a'], match: undefined }]])
    const right = () => new Map([[1, { score: 3, terms: ['b'], match: undefined }], [2, { score: 4, terms: ['b'], match: undefined }]])
    expect(combineResults([left(), right()], OR)).toEqual(new Map([
      [0, { score: 1, terms: ['a'], match: undefined }],
      [1, { score: 5, terms: ['a', 'b'], match: undefined }],
      [2, { score: 4, terms: ['b'], match: undefined }],
    ]))
    expect(combineResults([left(), right()], AND)).toEqual(new Map([[1, { score: 5, terms: ['a', 'b'], match: undefined }]]))
    expect(Array.from(combineResults([left(), right()], AND_NOT).keys())).toEqual([0])
  })

  test.each([0, 1024, 5000])('builds identical match objects at derived term ordinal %i', (ordinal) => {
    const fieldTermData = mapPostings(0, [[0, 1], [1, 1]])
    const run = derivedTerm => aggregateTerm(
      'src', derivedTerm, 1, 1,
      fieldTermData, fieldBoosts, makeContext(),
      undefined, defaultBM25params, new Map(), undefined, ordinal,
    )
    for (const term of ['derived', '42', 'constructor', 'toString']) {
      const match = run(term).get(0).match
      expect(Object.getPrototypeOf(match)).toBe(Object.prototype)
      expect(Object.keys(match)).toEqual([term])
      expect(Object.hasOwn(match, term)).toBe(true)
      expect(match[term]).toEqual(['text'])
    }
    const protoMatch = run('__proto__').get(0).match
    expect(Object.getPrototypeOf(protoMatch)).toBe(Object.prototype)
    expect(Object.keys(protoMatch)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(protoMatch, '__proto__').value).toEqual(['text'])
  })

  test('scores segment postings via allowed-docs seek path', () => {
    const docIds = new Uint32Array(10_000)
    const freqs = new Uint8Array(10_000)
    for (let i = 0; i < docIds.length; i++) {
      docIds[i] = i
      freqs[i] = 1
    }
    const list = new SegmentPostingList(docIds, freqs, 0, docIds.length)
    const fieldTermData = {
      get(fieldId) {
        return fieldId === 0 ? list : undefined
      },
    }
    const allowedDocs = new Set([42, 9999])
    const results = aggregateTerm(
      'seek', 'seek', 1, 1,
      fieldTermData, fieldBoosts, makeContext({ documentCount: 10_000 }),
      undefined, defaultBM25params, new Map(),
      { allowedDocs },
    )
    expect(Array.from(results.keys()).sort()).toEqual([42, 9999])
  })
})

describe('collectDocIdsFromFieldTermData', () => {
  test('collects doc ids from map postings with allowed-docs gate', () => {
    const fieldTermData = mapPostings(0, [[0, 1], [1, 2], [2, 1], [3, 1]])
    const docIds = new Set()
    collectDocIdsFromFieldTermData(
      fieldTermData,
      fieldBoosts,
      makeContext(),
      docIds,
      new Set([1, 3]),
    )
    expect(Array.from(docIds).sort()).toEqual([1, 3])
  })

  test('collects doc ids from segment postings via seek path', () => {
    const docIdsArray = new Uint32Array(10_000)
    const freqs = new Uint8Array(10_000)
    for (let i = 0; i < docIdsArray.length; i++) {
      docIdsArray[i] = i * 2
      freqs[i] = 1
    }
    const list = new SegmentPostingList(docIdsArray, freqs, 0, docIdsArray.length)
    const fieldTermData = { get: fieldId => (fieldId === 0 ? list : undefined) }
    const docIds = new Set()
    collectDocIdsFromFieldTermData(
      fieldTermData,
      fieldBoosts,
      makeContext(),
      docIds,
      new Set([4, 16, 99]),
    )
    expect(Array.from(docIds).sort((a, b) => a - b)).toEqual([4, 16])
  })
})

describe('finalizeSearchResults limit', () => {
  function randomRawResults(size, seed) {
    let state = seed
    const rand = () => {
      state = (state * 1103515245 + 12345) >>> 0
      return state / 0x100000000
    }
    const raw = new Map()
    for (let i = 0; i < size; i++) {
      const docId = Math.floor(rand() * 1_000_000)
      if (raw.has(docId)) continue
      // Few distinct scores, so ties are frequent.
      const terms = rand() < 0.3 ? ['a', 'b'] : ['a']
      raw.set(docId, { score: Math.floor(rand() * 5) / 2, terms, match: { [`t${docId % 3}`]: ['text'] } })
    }
    return raw
  }

  const base = {
    getExternalId: docId => `doc-${docId}`,
    getStoredFields: docId => ({ bucket: docId % 4 }),
  }

  test.each([[0, 1], [20, 10], [190, 20], [200, 10], [0, 0]])('unfiltered page materializes only returned records for offset=%i, limit=%i', (offset, limit) => {
    for (const skipSort of [false, true]) {
      const rawResults = randomRawResults(200, 9)
      const full = finalizeSearchResults({ ...base, rawResults, skipSort })
      const getStoredFields = vi.fn(base.getStoredFields)
      const page = finalizeSearchPage({ ...base, rawResults, skipSort, getStoredFields }, offset, limit)
      expect(page).toEqual({ results: full.slice(offset, offset + limit), total: full.length })
      expect(getStoredFields).toHaveBeenCalledTimes(page.results.length)
    }
  })

  test.each([
    ['unfiltered', {}],
    ['filtered', { filter: r => r.bucket !== 1 }],
  ])('%s deep page windows keep the full order among frequent ties', (_name, extra) => {
    for (const seed of [1, 2, 3]) {
      const rawResults = randomRawResults(2000, seed)
      const full = finalizeSearchResults({ ...base, ...extra, rawResults })
      for (const [offset, limit] of [[0, 300], [1, 256], [250, 20], [300, 50], [1000, 100], [full.length - 5, 20], [1500, Infinity]]) {
        expect(finalizeSearchPage({ ...base, ...extra, rawResults }, offset, limit))
          .toEqual({ results: full.slice(offset, offset + limit), total: full.length })
      }
    }
  })

  test.each([
    ['sorted', {}],
    ['sorted + filter', { filter: r => r.bucket !== 1 }],
    ['skipSort', { skipSort: true }],
    ['skipSort + filter', { skipSort: true, filter: r => r.bucket === 2 }],
  ])('%s equals slicing the unbounded results', (_name, extra) => {
    for (const size of [0, 1, 2, 7, 50, 300]) {
      for (const seed of [1, 2, 3]) {
        const full = finalizeSearchResults({ ...base, ...extra, rawResults: randomRawResults(size, seed) })
        for (const limit of [0, 1, 2, 5, size - 1, size, size + 3]) {
          if (limit < 0) continue
          const limited = finalizeSearchResults({ ...base, ...extra, limit, rawResults: randomRawResults(size, seed) })
          expect(limited).toEqual(full.slice(0, limit))
        }
      }
    }
  })

  test('all-equal scores keep insertion order', () => {
    const raw = new Map([[5, { score: 1, terms: ['a'], match: { a: ['t'] } }], [1, { score: 1, terms: ['a'], match: { a: ['t'] } }], [9, { score: 1, terms: ['a'], match: { a: ['t'] } }]])
    expect(finalizeSearchResults({ ...base, rawResults: raw, limit: 2 }).map(r => r.id)).toEqual(['doc-5', 'doc-1'])
  })

  test('filter stops once the limit is reached', () => {
    let calls = 0
    const raw = randomRawResults(200, 9)
    const results = finalizeSearchResults({ ...base, rawResults: raw, limit: 3, filter: () => { calls++; return true } })
    expect(results).toHaveLength(3)
    expect(calls).toBe(3)
  })

  test.each([-1, 1.5, NaN, '3', null])('rejects invalid limit %s', (limit) => {
    expect(() => finalizeRawSearchResults(new Map(), 'q', { limit }, defaultSearchOptions, id => id))
      .toThrow('limit must be a non-negative integer or Infinity')
  })

  test('Infinity means no limit', () => {
    const raw = randomRawResults(20, 4)
    const full = finalizeRawSearchResults(randomRawResults(20, 4), 'q', {}, defaultSearchOptions, id => id)
    expect(finalizeRawSearchResults(raw, 'q', { limit: Infinity }, defaultSearchOptions, id => id)).toEqual(full)
  })

  test('only retained results read ids and stored fields without a filter', () => {
    let ids = 0
    let fields = 0
    const results = finalizeSearchResults({
      rawResults: randomRawResults(200, 9),
      limit: 10,
      getExternalId: (id) => { ids++; return id },
      getStoredFields: () => { fields++; return { label: 'stored' } },
    })
    expect(results).toHaveLength(10)
    expect(ids).toBe(10)
    expect(fields).toBe(10)
  })

  test.each([1, 10, 100, 199])('filter sees ranked candidates until %i are accepted', (limit) => {
    const raw = randomRawResults(500, 9)
    const full = finalizeSearchResults({ ...base, rawResults: raw })
    const visited = []
    const accepted = r => r.bucket === 2
    const results = finalizeSearchResults({
      ...base, rawResults: raw, limit,
      filter: (r) => { visited.push(r.id); return accepted(r) },
    })
    expect(results).toEqual(full.filter(accepted).slice(0, limit))
    const last = results.length === limit ? full.findIndex(r => r.id === results.at(-1).id) + 1 : full.length
    expect(visited).toEqual(full.slice(0, last).map(r => r.id))
  })

  test('a highly selective filter consumes the ranked remainder without revisiting candidates', () => {
    const raw = randomRawResults(500, 9)
    const full = finalizeSearchResults({ ...base, rawResults: raw })
    const keep = new Set(full.slice(-2).map(r => r.id))
    const visited = []
    const results = finalizeSearchResults({
      ...base, rawResults: raw, limit: 3,
      filter: (r) => { visited.push(r.id); return keep.has(r.id) },
    })
    expect(results).toEqual(full.slice(-2))
    expect(visited).toEqual(full.map(r => r.id))
  })
})
