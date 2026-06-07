import FrozenMiniSearch, { freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { createFrozenIndexBuilder } from './frozenBuild'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance', category: 'fiction' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title', 'category'],
  searchOptions: { prefix: true, fuzzy: 0.2 },
}

describe('FrozenMiniSearch core', () => {
  test('fromDocuments indexes and searches', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, options)
    expect(index.documentCount).toBe(2)
    expect(index.search('zen').length).toBeGreaterThan(0)
  })

  test('builder path matches fromDocuments', () => {
    const builder = createFrozenIndexBuilder(options)
    for (const doc of docs) builder.add(doc)
    const built = freezeFrozenIndexBuilder(builder)
    const direct = FrozenMiniSearch.fromDocuments(docs, options)
    expect(built.search('zen').map(r => r.id)).toEqual(direct.search('zen').map(r => r.id))
  })

  test('binary round-trip', () => {
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options)
    expect(loaded.search('zen').map(r => r.id)).toEqual(frozen.search('zen').map(r => r.id))
  })

  test('rejects missing document id', () => {
    expect(() => FrozenMiniSearch.fromDocuments([{ text: 'a' }], { fields: ['text'] }))
      .toThrow(/ID/)
  })
})
