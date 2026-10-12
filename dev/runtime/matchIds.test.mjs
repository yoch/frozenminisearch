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
const withoutMatch = ({ terms, match, ...result }) => result

for (const [name, Ctor] of [['ESM', FrozenMiniSearch], ['CJS', FrozenMiniSearchCjs], ['browser', FrozenMiniSearchBrowser]]) {
  test(`${name}: matchIds and matchInfo: false agree with search`, () => {
    const index = Ctor.fromDocuments(docs, options)
    for (const [query, searchOptions] of [
      ['alpha beta', {}],
      ['uni', { prefix: true }],
      ['alhpa', { fuzzy: 2 }],
      [{ combineWith: 'AND_NOT', queries: ['alpha', 'beta'] }, {}],
      [Ctor.wildcard, {}],
      [Ctor.wildcard, { boostDocument: id => 1 + id % 7 }],
    ]) {
      const full = index.search(query, searchOptions)
      assert.deepEqual(index.matchIds(query, searchOptions), full.map(r => r.id).sort((a, b) => a - b))
      assert.deepEqual(index.search(query, { ...searchOptions, matchInfo: false }), full.map(withoutMatch))
      assert.deepEqual(index.searchPage(query, { ...searchOptions, matchInfo: false, offset: 1, limit: 20 }), {
        results: full.slice(1, 21).map(withoutMatch), total: full.length,
      })
    }
  })
}
