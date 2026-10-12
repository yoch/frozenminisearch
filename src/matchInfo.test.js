import FrozenMiniSearch from './FrozenMiniSearch'
import FrozenMiniSearchBrowser from './FrozenMiniSearchBrowser'
import { executeRaw, searchWithRunOptions } from './internal/frozenInternals'

const docs = Array.from({ length: 350 }, (_, i) => ({
  id: i,
  title: `${i % 3 === 0 ? 'alpha' : 'alphabet'} café`,
  text: `${'alpha '.repeat(1 + i % 7)}beta ${i % 5 === 0 ? 'gamma' : 'delta'}`,
  bucket: i % 11,
}))
const options = { fields: ['title', 'text'], storeFields: ['title', 'bucket'] }
const index = FrozenMiniSearch.fromDocuments(docs, options)

const withoutMatch = ({ terms, match, ...result }) => result
const hasMatchInfo = result => Object.hasOwn(result, 'terms') || Object.hasOwn(result, 'match')

const cases = [
  ['OR', 'alpha gamma', {}],
  ['AND', 'alpha gamma', { combineWith: 'AND' }],
  ['AND_NOT', 'alpha gamma', { combineWith: 'AND_NOT' }],
  ['prefix and fuzzy', 'alph gama', { prefix: true, fuzzy: 1 }],
  ['nested', { combineWith: 'AND', queries: ['alph', { queries: ['gamma', 'delta'] }] }, { prefix: true }],
  ['nested exclusion', { combineWith: 'AND_NOT', queries: ['alpha', { combineWith: 'AND', queries: ['beta', 'gamma'] }] }, {}],
  ['nested wildcard', { queries: [FrozenMiniSearch.wildcard, 'gamma'] }, {}],
  ['boosts', 'alph beta', {
    prefix: true, boost: { title: 2 }, boostTerm: term => (term === 'beta' ? 3 : 1),
    boostDocument: (id, term) => (term === 'alphabet' ? 2 : 1 + id % 3),
  }],
  ['equal scores', 'café', {}],
  ['filter', 'alpha beta', { filter: r => r.bucket % 2 === 0 }],
  ['empty', '', {}],
  ['wildcard', FrozenMiniSearch.wildcard, {}],
  ['wildcard filter', FrozenMiniSearch.wildcard, { filter: r => r.bucket === 0 }],
  ['wildcard boost', FrozenMiniSearch.wildcard, { boostDocument: id => 1 + id % 7 }],
]

describe('search with matchInfo: false', () => {
  test.each(cases)('%s keeps scores, order and stored fields without terms or match', (_name, query, searchOptions) => {
    for (const limit of [undefined, 1, 10, 1000]) {
      const full = index.search(query, { ...searchOptions, limit })
      const reduced = index.search(query, { ...searchOptions, limit, matchInfo: false })
      expect(reduced).toEqual(full.map(withoutMatch))
      expect(reduced.some(hasMatchInfo)).toBe(false)
    }
  })

  test.each(cases)('%s pages keep scores, order and totals without terms or match', (_name, query, searchOptions) => {
    const total = index.search(query, searchOptions).length
    for (const [offset, limit] of [[0, 0], [0, 10], [20, 10], [total + 1, 10], [1, Infinity]]) {
      const page = index.searchPage(query, { ...searchOptions, offset, limit })
      const reduced = index.searchPage(query, { ...searchOptions, offset, limit, matchInfo: false })
      expect(reduced).toEqual({ results: page.results.map(withoutMatch), total: page.total })
      expect(reduced.results.some(hasMatchInfo)).toBe(false)
    }
  })

  test.each(cases)('%s raw results skip match objects but keep scores, terms and order', (_name, query, searchOptions) => {
    const full = executeRaw(index, query, searchOptions)
    const reduced = executeRaw(index, query, searchOptions, false)
    expect(Array.from(reduced.keys())).toEqual(Array.from(full.keys()))
    for (const [docId, { score, terms, match }] of reduced) {
      expect(match).toBeUndefined()
      expect(score).toBe(full.get(docId).score)
      expect(terms).toEqual(full.get(docId).terms)
    }
  })

  test('local and index-level filters receive results without match information', () => {
    const seen = []
    const filter = (result) => {
      seen.push(result)
      return result.bucket === 0
    }
    const defaults = FrozenMiniSearch.fromDocuments(docs, { ...options, searchOptions: { filter } })
    const expected = index.search('alpha', { filter: r => r.bucket === 0 }).map(withoutMatch)
    expect(index.search('alpha', { filter, matchInfo: false })).toEqual(expected)
    expect(defaults.search('alpha', { matchInfo: false })).toEqual(expected)
    expect(defaults.searchPage('alpha', { matchInfo: false, limit: 5 }))
      .toEqual({ results: expected.slice(0, 5), total: expected.length })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some(hasMatchInfo)).toBe(false)
  })

  test('matchInfo is read from the call only, not from index-level search options', () => {
    const defaults = FrozenMiniSearch.fromDocuments(docs, { ...options, searchOptions: { matchInfo: false } })
    expect(defaults.search('alpha gamma')).toEqual(index.search('alpha gamma'))
  })

  test('gated AND and AND_NOT match the ungated evaluation', () => {
    const large = FrozenMiniSearch.fromDocuments(Array.from({ length: 6000 }, (_, i) => ({
      id: i,
      text: `common ${i % 50 === 0 ? 'rare' : 'usual'} ${i % 2 === 0 ? 'half' : 'other'} word${i % 97}`,
    })), { fields: ['text'] })
    for (const [query, searchOptions] of [
      ['common rare', { combineWith: 'AND' }],
      ['common half', { combineWith: 'AND_NOT' }],
      ['common wor', { combineWith: 'AND', prefix: true }],
      [{ combineWith: 'AND_NOT', queries: ['common', 'half rare'] }, {}],
    ]) {
      const naive = searchWithRunOptions(large, query, searchOptions, { disableGating: true }).map(withoutMatch)
      expect(naive.length).toBeGreaterThan(0)
      expect(large.search(query, { ...searchOptions, matchInfo: false })).toEqual(naive)
    }
  })

  test('autoSuggest is unaffected by matchInfo', () => {
    for (const suggestOptions of [{ prefix: true }, { prefix: true, filter: r => r.bucket === 0 }]) {
      expect(index.autoSuggest('alph be', { ...suggestOptions, matchInfo: false }))
        .toEqual(index.autoSuggest('alph be', suggestOptions))
    }
  })

  test('a search without match information can run inside boostDocument of a full search', () => {
    const boostDocument = id => 1 + id % 3
    const expected = index.search('alph gamma', { prefix: true, boostDocument })
    const results = index.search('alph gamma', {
      prefix: true,
      boostDocument: (id) => {
        index.search('bet', { prefix: true, matchInfo: false })
        return boostDocument(id)
      },
    })
    expect(results).toEqual(expected)
  })

  test('JSON, Node and browser binary loads and the browser class drop match information alike', async () => {
    const binary = index.saveBinarySync({ compression: 'raw' })
    const engines = [
      FrozenMiniSearch.fromJSON(JSON.stringify(index.toJSON()), options),
      FrozenMiniSearch.loadBinarySync(binary, options),
      await FrozenMiniSearchBrowser.loadBinaryAsync(binary, options),
      FrozenMiniSearchBrowser.fromDocuments(docs, options),
    ]
    for (const engine of engines) {
      for (const [, query, searchOptions] of cases) {
        expect(engine.search(query, { ...searchOptions, matchInfo: false }))
          .toEqual(index.search(query, { ...searchOptions, matchInfo: false }))
        expect(engine.searchPage(query, { ...searchOptions, offset: 10, limit: 20, matchInfo: false }))
          .toEqual(index.searchPage(query, { ...searchOptions, offset: 10, limit: 20, matchInfo: false }))
      }
    }
  })
})
