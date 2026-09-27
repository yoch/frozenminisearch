import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenFromMiniSearch } from '../testSupport/frozenImportHelpers'
import { MSV5_HEADER_SIZE } from './msv5/binaryMsv5Constants'
import { frozenPostings, frozenTermIndex } from './internal/frozenInternals'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  searchOptions: { prefix: true },
}

function corruptPayloadAfterLoad(buf) {
  buf.fill(0, MSV5_HEADER_SIZE)
}

describe('frozenOwnedSnapshot wire buffer isolation', () => {
  test.each(['raw', 'zlib'])('search stays stable after mutating the source buffer (%s)', (compression) => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const buf = frozen.saveBinarySync({ compression })
    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
    const query = 'ishmael'
    const expected = loaded.search(query, options.searchOptions)

    corruptPayloadAfterLoad(buf)
    expect(loaded.search(query, options.searchOptions)).toEqual(expected)
  })
})

describe('frozenOwnedSnapshot decoded payload release', () => {
  const storedDocs = Array.from({ length: 200 }, (_, id) => ({ id, text: `document ${id} ${'x'.repeat(200)}` }))
  const storedOptions = { fields: ['text'], storeFields: ['text'] }

  test.each([
    ['sync', buf => FrozenMiniSearch.loadBinarySync(buf, storedOptions)],
    ['async', buf => FrozenMiniSearch.loadBinaryAsync(buf, storedOptions)],
  ])('compressed %s load owns compact typed arrays', async (_mode, load) => {
    const buf = FrozenMiniSearch.fromDocuments(storedDocs, storedOptions).saveBinarySync({ compression: 'zlib' })
    const loaded = await load(buf)
    const postings = frozenPostings(loaded)
    const index = frozenTermIndex(loaded)
    const arrays = [
      postings.allDocIds,
      postings.allFreqs,
      index.nodeEdgeOffset,
      index.edgeChild,
    ]
    for (const array of arrays) {
      expect(array.buffer.byteLength).toBe(array.byteLength)
    }
    expect(loaded.getStoredFields(7)).toEqual({ text: storedDocs[7].text })
  })
})
