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

// Document ids equal insertion ranks, so insertion order is ascending id order.
const matchedIds = results => results.map(r => r.id).sort((a, b) => a - b)

const cases = [
  ['OR', 'alpha gamma', {}],
  ['AND', 'alpha gamma', { combineWith: 'AND' }],
  ['AND_NOT', 'alpha gamma', { combineWith: 'AND_NOT' }],
  ['prefix and fuzzy', 'alph gama', { prefix: true, fuzzy: 1 }],
  ['prefix and fuzzy functions', 'alph gama', {
    prefix: (_term, i) => i === 0, fuzzy: (_term, i) => (i === 1 ? 1 : false),
  }],
  ['fields', 'café gamma', { fields: ['title'] }],
  ['nested', { combineWith: 'AND', queries: ['alpha', { queries: ['gamma', 'delta'] }] }, {}],
  ['nested exclusion', { combineWith: 'AND_NOT', queries: ['alpha', { combineWith: 'AND', queries: ['beta', 'gamma'] }] }, {}],
  ['nested wildcard', { combineWith: 'AND_NOT', queries: [FrozenMiniSearch.wildcard, 'gamma'] }, {}],
  ['boostDocument excludes documents', 'alpha gamma', { boostDocument: id => id % 4 }],
  ['boostDocument by derived term', 'alph', { prefix: true, boostDocument: (id, term) => (term === 'alphabet' ? 1 : id % 2) }],
  ['boostDocument on negated terms', 'alpha gamma', {
    combineWith: 'AND_NOT', boostDocument: (id, term) => (term === 'gamma' ? id % 2 : 1),
  }],
  ['scoring options do not change matches', 'alph beta', {
    prefix: true, boost: { title: 0 }, boostTerm: () => 0, weights: { prefix: 0, fuzzy: 0 },
  }],
  ['processTerm returning an array', 'alpha+gamma', { tokenize: text => [text], processTerm: term => term.split('+') }],
  ['processTerm dropping terms', 'the gamma', { processTerm: term => (term === 'the' ? null : term) }],
  ['processTerm rejecting all terms', 'alpha', { processTerm: () => false }],
  ['empty', '', {}],
  ['no matches', 'missingword', {}],
  ['wildcard', FrozenMiniSearch.wildcard, {}],
  ['wildcard with a zero boost', FrozenMiniSearch.wildcard, { boostDocument: () => 0 }],
]

describe('matchIds', () => {
  test.each(cases)('%s returns the documents of search, in insertion order', (_name, query, searchOptions) => {
    expect(index.matchIds(query, searchOptions)).toEqual(matchedIds(index.search(query, searchOptions)))
  })

  test('follows insertion order rather than id or score order', () => {
    const named = FrozenMiniSearch.fromDocuments([
      { id: 'z', text: 'alpha' },
      { id: 'a', text: 'alpha alpha alpha' },
      { id: 'm', text: 'beta' },
      { id: 'b', text: 'alpha beta' },
    ], { fields: ['text'] })
    expect(named.search('alpha').map(r => r.id)).not.toEqual(['z', 'a', 'b'])
    expect(named.matchIds('alpha')).toEqual(['z', 'a', 'b'])
    expect(named.matchIds(FrozenMiniSearch.wildcard)).toEqual(['z', 'a', 'm', 'b'])
  })

  test.each([
    [{ filter: () => true }, /does not support filter/],
    [{ limit: 10 }, /does not support limit/],
    [{ limit: 0 }, /does not support limit/],
  ])('rejects %o before query callbacks', (searchOptions, error) => {
    const tokenize = vi.fn(text => text.split(' '))
    expect(() => index.matchIds('alpha', { ...searchOptions, tokenize })).toThrow(error)
    expect(tokenize).not.toHaveBeenCalled()
  })

  test('rejects an index-level filter unless the call disables it, and ignores an index-level limit', () => {
    const tokenize = vi.fn(text => text.split(' '))
    const defaults = FrozenMiniSearch.fromDocuments(docs, {
      ...options, searchOptions: { filter: r => r.bucket === 0, limit: 1, tokenize },
    })
    expect(() => defaults.matchIds('alpha gamma')).toThrow(/does not support filter/)
    expect(tokenize).not.toHaveBeenCalled()
    expect(defaults.matchIds('alpha gamma', { filter: undefined }))
      .toEqual(matchedIds(defaults.search('alpha gamma', { filter: undefined, limit: undefined })))
  })

  test('collects a broad first term of an AND under the gate of a selective one', () => {
    const query = 'alpha gamma'
    expect(index.matchIds(query, { combineWith: 'AND' }))
      .toEqual(matchedIds(index.search(query, { combineWith: 'AND' })))
    expect(index.matchIds('gamma alpha', { combineWith: 'AND' })).toEqual(index.matchIds(query, { combineWith: 'AND' }))
  })

  test('applies index-level options to terms but not to combination operators, like search', () => {
    const defaults = FrozenMiniSearch.fromDocuments(docs, {
      ...options, searchOptions: { combineWith: 'AND', prefix: true },
    })
    for (const query of ['alph gamma', { queries: ['alph', 'gamma'] }, { queries: ['alph gamma', 'delta'] }]) {
      const expected = matchedIds(defaults.search(query))
      expect(expected.length).toBeGreaterThan(0)
      expect(defaults.matchIds(query)).toEqual(expected)
    }
  })

  test.each(['XOR', 'constructor', '__proto__', 'toString'])('rejects the invalid operator %s like search', (combineWith) => {
    for (const query of ['alpha', 'alpha gamma']) {
      expect(() => index.search(query, { combineWith })).toThrow(/invalid combination operator/)
      expect(() => index.matchIds(query, { combineWith })).toThrow(/invalid combination operator/)
    }
    expect(index.search('', { combineWith })).toEqual([])
    expect(index.matchIds('', { combineWith })).toEqual([])
  })

  test('boostDocument can re-enter the same index during prefix traversal', () => {
    const expected = matchedIds(index.search('alph', { prefix: true, boostDocument: id => id % 2 }))
    const ids = index.matchIds('alph', {
      prefix: true,
      boostDocument: (id) => {
        index.matchIds('gam', { prefix: true })
        index.search('bet', { prefix: true, limit: 1 })
        return id % 2
      },
    })
    expect(ids).toEqual(expected)
  })

  test('skips discarded documents of an imported MiniSearch snapshot', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    for (const id of [0, 1, 4, 19, 100]) mutable.discard(id)
    const loaded = FrozenMiniSearch.fromJSON(JSON.stringify(mutable.toJSON()), options)
    for (const query of [FrozenMiniSearch.wildcard, 'alpha', 'gamma']) {
      const ids = loaded.matchIds(query)
      expect(ids).toEqual(matchedIds(loaded.search(query)))
      expect(ids).not.toContain(4)
    }
  })

  test('JSON, Node and browser binary loads and the browser class return the same ids', async () => {
    const binary = index.saveBinarySync({ compression: 'raw' })
    const engines = [
      FrozenMiniSearch.fromJSON(JSON.stringify(index.toJSON()), options),
      FrozenMiniSearch.loadBinarySync(binary, options),
      await FrozenMiniSearchBrowser.loadBinaryAsync(binary, options),
      FrozenMiniSearchBrowser.fromDocuments(docs, options),
    ]
    for (const engine of engines) {
      for (const [, query, searchOptions] of cases) {
        expect(engine.matchIds(query, searchOptions)).toEqual(index.matchIds(query, searchOptions))
      }
    }
  })
})
