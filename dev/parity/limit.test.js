import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'
import FrozenMiniSearchBrowser from '../../src/FrozenMiniSearchBrowser'
import { searchNaive } from './queryEngineHarness'

const docs = Array.from({ length: 350 }, (_, i) => ({
  id: i,
  title: `${i % 3 === 0 ? 'alpha' : 'alphabet'} café`,
  text: `${'alpha '.repeat(1 + i % 7)}beta ${i % 5 === 0 ? 'gamma' : 'delta'}`,
  bucket: i % 11,
}))
const options = { fields: ['title', 'text'], storeFields: ['title', 'bucket'] }
const cases = [
  ['OR', 'alpha gamma', {}],
  ['AND', 'alpha gamma', { combineWith: 'AND' }],
  ['AND_NOT', 'alpha gamma', { combineWith: 'AND_NOT' }],
  ['prefix and fuzzy', 'alph gama', { prefix: true, fuzzy: 1 }],
  ['nested', { combineWith: 'AND', queries: ['alpha', { queries: ['gamma', 'delta'] }] }, {}],
  ['nested exclusion', { combineWith: 'AND_NOT', queries: ['alpha', { combineWith: 'AND', queries: ['beta', 'gamma'] }] }, {}],
  ['boosts', 'alpha beta', { boost: { title: 2 }, boostTerm: term => term === 'beta' ? 3 : 1, boostDocument: id => 1 + id % 3 }],
  ['Unicode', 'café', {}],
  ['filter', 'alpha beta', { filter: r => r.bucket === 0 }],
  ['reject all', 'alpha', { filter: () => false }],
  ['empty', '', {}],
  ['wildcard', FrozenMiniSearch.wildcard, {}],
  ['wildcard filter', FrozenMiniSearch.wildcard, { filter: r => r.bucket === 0 }],
  ['wildcard boost', FrozenMiniSearch.wildcard, { boostDocument: id => 1 + id % 7 }],
]

describe('limit parity', () => {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = FrozenMiniSearch.fromDocuments(docs, options)

  test.each(cases)('%s keeps complete scores and metadata', (_name, query, searchOptions) => {
    const full = frozen.search(query, searchOptions)
    const upstream = mutable.search(query === FrozenMiniSearch.wildcard ? MiniSearch.wildcard : query, searchOptions)
    for (const limit of [0, 1, 10, 20, Math.max(0, full.length - 1), full.length, full.length + 1, Infinity]) {
      const limited = frozen.search(query, { ...searchOptions, limit })
      expect(limited).toEqual(full.slice(0, limit))
      // Gated and non-gated execution must agree even when only a few results are returned.
      expect(limited).toEqual(searchNaive(frozen, query, { ...searchOptions, limit }))
      const expected = upstream.slice(0, limit)
      expect(limited.map(r => r.id)).toEqual(expected.map(r => r.id))
      for (let i = 0; i < limited.length; i++) {
        expect(limited[i].score).toBeCloseTo(expected[i].score, 6)
        expect(limited[i].match).toEqual(expected[i].match)
        expect(limited[i].queryTerms).toEqual(expected[i].queryTerms)
        expect(limited[i].bucket).toEqual(expected[i].bucket)
      }
    }
  })

  test('a document with modest partial scores can win after aggregation', () => {
    const index = FrozenMiniSearch.fromDocuments([
      { id: 'alpha', text: 'alpha' },
      { id: 'beta', text: 'beta' },
      { id: 'both', text: 'alpha beta' },
    ], { fields: ['text'] })
    expect(index.search('alpha beta', { limit: 1 })[0].id).toBe('both')
    expect(index.search('alpha beta', { limit: 1 })).toEqual(index.search('alpha beta').slice(0, 1))
  })

  test('global limit can be overridden or explicitly unset', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, { ...options, searchOptions: { limit: 3 } })
    expect(index.search('alpha')).toHaveLength(3)
    expect(index.search('alpha', { limit: 1 })).toHaveLength(1)
    expect(index.search('alpha', { limit: 0 })).toEqual([])
    expect(index.search('alpha', { limit: undefined })).toEqual(index.search('alpha', { limit: Infinity }))
    expect(index.search('alpha', { limit: Infinity }).length).toBeGreaterThan(3)
  })

  test('autoSuggest ignores global and local limits, including zero and invalid values', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, { ...options, searchOptions: { limit: 0 }, autoSuggestOptions: { limit: 1 } })
    for (const filter of [undefined, r => r.bucket === 0]) {
      const expected = frozen.autoSuggest('alp', { filter })
      for (const limit of [undefined, 0, 1, -1, NaN, Infinity]) {
        expect(index.autoSuggest('alp', { filter, limit })).toEqual(expected)
      }
    }
  })

  test('JSON, Node and browser binary loads preserve bounded results', async () => {
    const binary = frozen.saveBinarySync({ compression: 'raw' })
    const engines = [
      FrozenMiniSearch.fromJSON(JSON.stringify(frozen.toJSON()), options),
      FrozenMiniSearch.loadBinarySync(binary, options),
      await FrozenMiniSearchBrowser.loadBinaryAsync(binary, options),
    ]
    for (const engine of engines) {
      for (const [, query, searchOptions] of cases) {
        expect(engine.search(query, { ...searchOptions, limit: 10 })).toEqual(frozen.search(query, { ...searchOptions, limit: 10 }))
      }
    }
  })

  test('a filter can re-enter the same index without altering the outer result', () => {
    const expected = frozen.search('alpha beta').filter(r => r.bucket === 0).slice(0, 10)
    const results = frozen.search('alpha beta', {
      limit: 10,
      filter: r => {
        frozen.search('gama', { fuzzy: 1, limit: 1 })
        return r.bucket === 0
      },
    })
    expect(results).toEqual(expected)
  })

  test('bounded wildcard skips discarded document slots and retains stored fields', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    for (const id of [0, 1, 4, 5, 9, 10]) mutable.discard(id)
    const index = FrozenMiniSearch.fromJSON(JSON.stringify(mutable.toJSON()), options)
    for (const filter of [undefined, r => r.bucket === 0]) {
      const full = index.search(FrozenMiniSearch.wildcard, { filter })
      for (const limit of [1, 10, Infinity]) {
        expect(index.search(FrozenMiniSearch.wildcard, { filter, limit })).toEqual(full.slice(0, limit))
      }
    }
  })

  test('bounded wildcard uses effective global and local boost options', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, { ...options, searchOptions: { boostDocument: id => 1 + id % 7 } })
    expect(index.search(FrozenMiniSearch.wildcard, { limit: 10 })).toEqual(index.search(FrozenMiniSearch.wildcard).slice(0, 10))
    expect(index.search(FrozenMiniSearch.wildcard, { limit: 10, boostDocument: undefined }))
      .toEqual(frozen.search(FrozenMiniSearch.wildcard).slice(0, 10))
  })

  test('limit zero skips tokenization, scoring and filters', () => {
    const tokenize = vi.fn(() => { throw new Error('must not tokenize') })
    const boostDocument = vi.fn()
    const filter = vi.fn()
    expect(frozen.search('alpha', { limit: 0, tokenize, boostDocument, filter })).toEqual([])
    expect(tokenize).not.toHaveBeenCalled()
    expect(boostDocument).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
  })

  test.each([-1, -Infinity, 1.5, NaN, null, '10'])('invalid limit %s fails before query callbacks', (limit) => {
    const tokenize = vi.fn(() => { throw new Error('must not tokenize') })
    expect(() => frozen.search('alpha', { limit, tokenize })).toThrow('limit must be a non-negative integer or Infinity')
    expect(tokenize).not.toHaveBeenCalled()
  })
})
