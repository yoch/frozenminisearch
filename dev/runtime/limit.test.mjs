import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import FrozenMiniSearch from '@yoch/frozenminisearch'
import FrozenMiniSearchBrowser from '@yoch/frozenminisearch/browser'

const require = createRequire(import.meta.url)
const FrozenMiniSearchCjs = require('@yoch/frozenminisearch')
const docs = Array.from({ length: 1000 }, (_, i) => ({
  id: `doc-${i}`,
  text: `${'alpha '.repeat(1 + i % 7)}${i % 3 === 0 ? 'beta' : 'gamma'} unique${i}`,
  bucket: i % 100,
}))
const options = { fields: ['text'], storeFields: ['bucket'] }

for (const [name, Ctor] of [['ESM', FrozenMiniSearch], ['CJS', FrozenMiniSearchCjs], ['browser', FrozenMiniSearchBrowser]]) {
  test(`${name}: bounded public searches keep complete scores and stable order`, () => {
    const index = Ctor.fromDocuments(docs, options)
    for (const [query, searchOptions] of [
      ['alpha beta', {}],
      ['uni', { prefix: true }],
      ['alhpa', { fuzzy: 2 }],
      [{ combineWith: 'AND_NOT', queries: ['alpha', 'beta'] }, {}],
      [Ctor.wildcard, {}],
      [Ctor.wildcard, { boostDocument: id => 1 + Number(id.slice(4)) % 7 }],
    ]) {
      for (const filter of [undefined, r => r.bucket % 2 === 0, r => r.bucket === 0, () => false]) {
        const full = index.search(query, { ...searchOptions, filter })
        for (const limit of [0, 1, 20, 500, 1001, Infinity]) {
          assert.deepEqual(index.search(query, { ...searchOptions, filter, limit }), full.slice(0, limit))
        }
      }
    }
  })

  test(`${name}: bounded binary-loaded search`, async () => {
    const index = Ctor.fromDocuments(docs, options)
    const loaded = await Ctor.loadBinaryAsync(await index.saveBinaryAsync({ compression: 'raw' }), options)
    for (const query of ['alpha beta', Ctor.wildcard]) {
      const searchOptions = { filter: r => r.bucket === 0, limit: 3 }
      assert.deepEqual(loaded.search(query, searchOptions), index.search(query, searchOptions))
    }
  })
}
