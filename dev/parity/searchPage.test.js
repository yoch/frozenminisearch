import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'

const docs = Array.from({ length: 200 }, (_, id) => ({
  id, text: `${'alpha '.repeat(id % 7 + 1)}${id % 3 === 0 ? 'beta' : 'gamma'}`, bucket: id % 5,
}))
const options = { fields: ['text'], storeFields: ['bucket'] }

describe('searchPage parity with unbounded MiniSearch', () => {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = FrozenMiniSearch.fromDocuments(docs, options)

  test.each([
    ['alpha beta', {}],
    ['alpha beta', { combineWith: 'AND' }],
    ['alpha beta', { combineWith: 'AND_NOT' }],
    ['alph', { prefix: true, filter: r => r.bucket !== 1 }],
    ['alhpa', { fuzzy: 2 }],
    [MiniSearch.wildcard, { filter: r => r.bucket === 0 }],
  ])('paginates %s with %j', (query, searchOptions) => {
    const full = mutable.search(query, searchOptions)
    const frozenQuery = query === MiniSearch.wildcard ? FrozenMiniSearch.wildcard : query
    for (const offset of [0, 1, 20, 150, full.length]) {
      const page = frozen.searchPage(frozenQuery, { ...searchOptions, offset, limit: 10 })
      const expected = full.slice(offset, offset + 10)
      expect(page.total).toBe(full.length)
      expect(page.results.map(r => r.id)).toEqual(expected.map(r => r.id))
      for (let i = 0; i < page.results.length; i++) {
        expect(page.results[i].score).toBeCloseTo(expected[i].score, 6)
        expect(page.results[i].match).toEqual(expected[i].match)
        expect(page.results[i].bucket).toBe(expected[i].bucket)
      }
    }
  })
})
