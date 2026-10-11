import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import FrozenMiniSearchBrowser from './FrozenMiniSearchBrowser'

const docs = Array.from({ length: 350 }, (_, i) => ({
  id: i,
  title: `${i % 3 === 0 ? 'alpha' : 'alphabet'} café`,
  text: `${'alpha '.repeat(1 + i % 7)}beta ${i % 5 === 0 ? 'gamma' : 'delta'}`,
  bucket: i % 11,
}))
const options = { fields: ['title', 'text'], storeFields: ['title', 'bucket'] }
const index = FrozenMiniSearch.fromDocuments(docs, options)
const cases = [
  ['OR', 'alpha gamma', {}],
  ['AND', 'alpha gamma', { combineWith: 'AND' }],
  ['AND_NOT', 'alpha gamma', { combineWith: 'AND_NOT' }],
  ['prefix and fuzzy', 'alph gama', { prefix: true, fuzzy: 1 }],
  ['nested', { combineWith: 'AND', queries: ['alpha', { queries: ['gamma', 'delta'] }] }, {}],
  ['boosts', 'alpha beta', { boost: { title: 2 }, boostDocument: id => 1 + id % 3 }],
  ['equal scores', 'café', {}],
  ['filter', 'alpha beta', { filter: r => r.bucket % 2 === 0 }],
  ['reject all', 'alpha', { filter: () => false }],
  ['empty', '', {}],
  ['no matches', 'missingword', {}],
  ['wildcard', FrozenMiniSearch.wildcard, {}],
  ['wildcard filter', FrozenMiniSearch.wildcard, { filter: r => r.bucket === 0 }],
  ['wildcard boost', FrozenMiniSearch.wildcard, { boostDocument: id => 1 + id % 7 }],
]

describe('searchPage', () => {
  test.each(cases)('%s preserves the full search order, metadata and total', (_name, query, searchOptions) => {
    const full = index.search(query, searchOptions)
    for (const [offset, limit] of [[0, 0], [0, 1], [1, 1], [20, 10], [100, 100],
      [Math.max(0, full.length - 2), 20], [full.length + 1, 10], [0, Infinity], [1, Infinity]]) {
      expect(index.searchPage(query, { ...searchOptions, offset, limit })).toEqual({
        results: full.slice(offset, offset + limit), total: full.length,
      })
    }
  })

  test.each([[0, 10], [20, 10], [0, 0], [400, 10]])('scores once and evaluates every filter candidate for offset=%i, limit=%i', (offset, limit) => {
    const full = index.search('alpha')
    const tokenize = vi.fn(text => text.split(' '))
    const filter = vi.fn(r => r.bucket === 0)
    const page = index.searchPage('alpha', { offset, limit, tokenize, filter })
    const expected = full.filter(r => r.bucket === 0)
    expect(page).toEqual({ results: expected.slice(offset, offset + limit), total: expected.length })
    expect(tokenize).toHaveBeenCalledTimes(1)
    expect(filter).toHaveBeenCalledTimes(full.length)
  })

  test('an explicit page size overrides a global limit, retaining other global options', () => {
    const filtered = FrozenMiniSearch.fromDocuments(docs, {
      ...options, searchOptions: { prefix: true, filter: r => r.bucket % 2 === 0, limit: 1 },
    })
    const full = filtered.search('alph', { limit: Infinity })
    expect(full.length).toBeGreaterThan(20)
    expect(filtered.searchPage('alph', { limit: 20 }))
      .toEqual({ results: full.slice(0, 20), total: full.length })
    expect(filtered.search('alph')).toHaveLength(1)
  })

  test.each([-1, 1.5, Infinity, NaN, null, '10'])('rejects invalid offset %s before query callbacks', (offset) => {
    const tokenize = vi.fn()
    expect(() => index.searchPage('alpha', { offset, limit: 10, tokenize })).toThrow(/offset must/)
    expect(tokenize).not.toHaveBeenCalled()
  })

  test.each([-1, 1.5, -Infinity, NaN, null, '10'])('rejects invalid limit %s before query callbacks', (limit) => {
    const tokenize = vi.fn()
    expect(() => index.searchPage('alpha', { limit, tokenize })).toThrow(/limit must/)
    expect(tokenize).not.toHaveBeenCalled()
  })

  test('requires a page size rather than inheriting a bounded-search default', () => {
    expect(() => index.searchPage('alpha')).toThrow(/requires an explicit limit/)
    expect(() => index.searchPage('alpha', {})).toThrow(/requires an explicit limit/)
  })

  test('a filter can re-enter the same index', () => {
    const full = index.search('alpha beta').filter(r => r.bucket === 0)
    const page = index.searchPage('alpha beta', {
      offset: 2, limit: 10,
      filter: (r) => {
        index.searchPage('gamma', { limit: 1 })
        return r.bucket === 0
      },
    })
    expect(page).toEqual({ results: full.slice(2, 12), total: full.length })
  })

  test('wildcard pages skip discarded slots and count only live documents', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    for (const id of [0, 1, 4, 19, 100]) mutable.discard(id)
    const loaded = FrozenMiniSearch.fromJSON(JSON.stringify(mutable.toJSON()), options)
    for (const filter of [undefined, r => r.bucket === 0]) {
      const full = loaded.search(FrozenMiniSearch.wildcard, { filter })
      for (const offset of [0, 1, 20, full.length + 1]) {
        expect(loaded.searchPage(FrozenMiniSearch.wildcard, { offset, limit: 10, filter }))
          .toEqual({ results: full.slice(offset, offset + 10), total: full.length })
      }
    }
  })

  test('wildcard paging respects global boosts and their local override', () => {
    const boosted = FrozenMiniSearch.fromDocuments(docs, {
      ...options, searchOptions: { boostDocument: id => 1 + id % 7 },
    })
    for (const localOptions of [{}, { boostDocument: undefined }]) {
      const full = boosted.search(FrozenMiniSearch.wildcard, localOptions)
      expect(boosted.searchPage(FrozenMiniSearch.wildcard, { ...localOptions, offset: 10, limit: 5 }))
        .toEqual({ results: full.slice(10, 15), total: full.length })
    }
  })

  test('JSON, Node and browser binary-loaded indexes retain page semantics', async () => {
    const binary = index.saveBinarySync({ compression: 'raw' })
    const engines = [
      FrozenMiniSearch.fromJSON(JSON.stringify(index.toJSON()), options),
      FrozenMiniSearch.loadBinarySync(binary, options),
      await FrozenMiniSearchBrowser.loadBinaryAsync(binary, options),
    ]
    for (const engine of engines) {
      for (const [, query, searchOptions] of cases) {
        expect(engine.searchPage(query, { ...searchOptions, offset: 10, limit: 20 }))
          .toEqual(index.searchPage(query, { ...searchOptions, offset: 10, limit: 20 }))
      }
    }
  })
})
