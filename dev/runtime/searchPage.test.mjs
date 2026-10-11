import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import FrozenMiniSearch from '@yoch/frozenminisearch'
import FrozenMiniSearchBrowser from '@yoch/frozenminisearch/browser'

const require = createRequire(import.meta.url)
const FrozenMiniSearchCjs = require('@yoch/frozenminisearch')
const docs = Array.from({ length: 250 }, (_, id) => ({
  id, text: `${'alpha '.repeat(1 + id % 7)}${id % 3 === 0 ? 'beta' : 'gamma'} unique${id}`, bucket: id % 11,
}))
const options = { fields: ['text'], storeFields: ['bucket'] }

for (const [name, Ctor] of [['ESM', FrozenMiniSearch], ['CJS', FrozenMiniSearchCjs], ['browser', FrozenMiniSearchBrowser]]) {
  test(`${name}: pages preserve scores, ordering, stored fields and exact totals`, () => {
    const index = Ctor.fromDocuments(docs, options)
    for (const [query, searchOptions] of [
      ['alpha beta', {}],
      ['uni', { prefix: true }],
      ['alhpa', { fuzzy: 2 }],
      [{ combineWith: 'AND_NOT', queries: ['alpha', 'beta'] }, {}],
      [Ctor.wildcard, {}],
      [Ctor.wildcard, { boostDocument: id => 1 + id % 7 }],
    ]) {
      for (const filter of [undefined, r => r.bucket === 0, () => false]) {
        const full = index.search(query, { ...searchOptions, filter })
        for (const [offset, limit] of [[0, 0], [0, 1], [1, 20], [100, 20], [251, 20], [1, Infinity]]) {
          assert.deepEqual(index.searchPage(query, { ...searchOptions, filter, offset, limit }), {
            results: full.slice(offset, offset + limit), total: full.length,
          })
        }
      }
    }
  })

  test(`${name}: binary-loaded pages preserve totals`, async () => {
    const index = Ctor.fromDocuments(docs, options)
    const loaded = await Ctor.loadBinaryAsync(await index.saveBinaryAsync({ compression: 'raw' }), options)
    const full = index.search('alpha', { filter: r => r.bucket === 0 })
    assert.deepEqual(loaded.searchPage('alpha', { offset: 1, limit: 5, filter: r => r.bucket === 0 }), {
      results: full.slice(1, 6), total: full.length,
    })
  })
}
