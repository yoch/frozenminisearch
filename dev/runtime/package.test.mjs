import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import zlib from 'node:zlib'
import * as esm from '@yoch/frozenminisearch'
import * as browser from '@yoch/frozenminisearch/browser'

const require = createRequire(import.meta.url)
const cjs = require('@yoch/frozenminisearch')
const documents = [
  { id: 'book-1', title: 'Moby Dick', text: 'Call me Ishmael', category: 'fiction' },
  { id: 'book-2', title: 'Zen', text: 'The art of motorcycle maintenance', category: 'nonfiction' },
  { id: 'book-3', title: 'Zen stories', text: 'Fictional zen art 😀 😁', category: 'fiction' },
]
const options = { fields: ['title', 'text'], storeFields: ['title', 'category'] }

for (const [name, entry] of [['ESM', esm], ['CommonJS', cjs], ['browser', browser]]) {
  const FrozenMiniSearch = entry.default

  test(`${name}: package exports, search, and suggestions`, () => {
    assert.equal(entry.FrozenMiniSearch, FrozenMiniSearch)
    if (name === 'CommonJS') assert.equal(cjs, FrozenMiniSearch)
    const index = FrozenMiniSearch.fromDocuments(documents, options)
    assert.deepEqual(index.search('ishmal', { fuzzy: 0.3 }).map(hit => hit.id), ['book-1'])
    assert.deepEqual(index.search('zen', {
      prefix: true,
      filter: hit => hit.category === 'fiction',
    }).map(hit => hit.id), ['book-3'])
    assert.ok(index.autoSuggest('zen ar').some(hit => hit.terms.includes('art')))
    assert.equal(index.has('book-2'), true)
    assert.deepEqual(index.getStoredFields('book-1'), { title: 'Moby Dick', category: 'fiction' })
  })

  test(`${name}: incremental builder and JSON import`, () => {
    const builder = entry.createFrozenIndexBuilder(options)
    builder.addAll(documents)
    const built = entry.freezeFrozenIndexBuilder(builder)
    const loaded = FrozenMiniSearch.fromJSON(JSON.stringify(built), options)
    assert.deepEqual(loaded.search('zen art', { combineWith: 'AND' }), built.search('zen art', { combineWith: 'AND' }))
  })

  for (const compression of ['raw', 'zlib', 'auto']) {
    test(`${name}: async binary round trip (${compression})`, async () => {
      const index = FrozenMiniSearch.fromDocuments(documents, options)
      const bytes = await index.saveBinaryAsync({ compression })
      const loaded = await FrozenMiniSearch.loadBinaryAsync(new Uint8Array(bytes), options)
      assert.deepEqual(loaded.search('zen', { limit: 1 }), index.search('zen', { limit: 1 }))
      assert.deepEqual(loaded.search('😀'), index.search('😀'))
      assert.deepEqual(loaded.search('😁'), index.search('😁'))
      assert.deepEqual(loaded.getStoredFields('book-1'), index.getStoredFields('book-1'))
    })
  }

  if (name !== 'browser') {
    for (const compression of ['raw', 'zlib', 'auto']) {
      test(`${name}: synchronous binary round trip (${compression})`, () => {
        const index = FrozenMiniSearch.fromDocuments(documents, options)
        const bytes = index.saveBinarySync({ compression })
        const loaded = FrozenMiniSearch.loadBinarySync(new Uint8Array(bytes), options)
        assert.deepEqual(loaded.search('zen'), index.search('zen'))
        assert.deepEqual(loaded.search('😀'), index.search('😀'))
      })
    }

    test(`${name}: zstd capability follows the runtime`, () => {
      const index = FrozenMiniSearch.fromDocuments(documents, options)
      if (typeof zlib.zstdCompressSync === 'function') {
        const loaded = FrozenMiniSearch.loadBinarySync(index.saveBinarySync({ compression: 'zstd' }), options)
        assert.deepEqual(loaded.search('zen'), index.search('zen'))
      } else {
        assert.throws(() => index.saveBinarySync({ compression: 'zstd' }), /zstd/)
      }
    })
  }
}

test('Node and browser exchange zlib snapshots', async () => {
  const nodeIndex = esm.default.fromDocuments(documents, options)
  const browserIndex = browser.default.fromDocuments(documents, options)
  const inBrowser = await browser.default.loadBinaryAsync(new Uint8Array(nodeIndex.saveBinarySync({ compression: 'zlib' })), options)
  const inNode = esm.default.loadBinarySync(await browserIndex.saveBinaryAsync({ compression: 'zlib' }), options)
  assert.deepEqual(inBrowser.search('zen'), nodeIndex.search('zen'))
  assert.deepEqual(inNode.search('zen'), browserIndex.search('zen'))
})
