import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenFromMiniSearch, frozenMemoryBreakdown } from './internal/frozenInternals'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title'],
  searchOptions: { prefix: true },
}

function validSnapshot(overrides = {}) {
  return {
    documentCount: 1,
    nextId: 1,
    documentIds: { 0: 'a' },
    fieldIds: { text: 0 },
    fieldLength: { 0: [1] },
    averageFieldLength: [1],
    storedFields: {},
    index: [['hello', { 0: { 0: 1 } }]],
    serializationVersion: 2,
    ...overrides,
  }
}

describe('fromMiniSearch loaders', () => {
  test('fromJSON matches reference search', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const json = JSON.stringify(reference)
    const frozen = FrozenMiniSearch.fromJSON(json, options)
    expect(frozen.search('zen')).toEqual(reference.search('zen'))
    expect(frozen.search('ishmael', { prefix: true }).map(r => r.id)).toEqual(
      reference.search('ishmael', { prefix: true }).map(r => r.id),
    )
  })

  test('fromJSON is the only public MiniSearch JSON loader name', () => {
    expect(typeof FrozenMiniSearch.fromJSON).toBe('function')
    expect('fromJson' in FrozenMiniSearch).toBe(false)
  })

  test('fromMiniSearch instance uses toJSON()', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const frozen = frozenFromMiniSearch(FrozenMiniSearch, reference, options)
    expect(frozen.documentCount).toBe(reference.documentCount)
    expect(frozen.search('zen art', { combineWith: 'AND' }).length).toBeGreaterThan(0)
  })

  test('fromJSON accepts serializationVersion 1 wire entries', () => {
    const snapshot = {
      documentCount: 1,
      nextId: 1,
      documentIds: { 0: 'a' },
      fieldIds: { text: 0 },
      fieldLength: { 0: [1] },
      averageFieldLength: [1],
      storedFields: {},
      dirtCount: 2,
      index: [
        ['hello', { 0: { ds: { 0: 1 } } }],
      ],
      serializationVersion: 1,
    }
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] })
    expect(frozen.search('hello').map(r => r.id)).toEqual(['a'])
  })

  test('fromJSON remaps sparse shortIds with gaps', () => {
    const snapshot = {
      documentCount: 2,
      nextId: 3,
      documentIds: { 0: 'a', 2: 'c' },
      fieldIds: { t: 0 },
      fieldLength: { 0: [1], 2: [1] },
      averageFieldLength: [1],
      storedFields: {},
      index: [
        ['alpha', { 0: { 0: 1 } }],
        ['gamma', { 0: { 2: 1 } }],
      ],
      serializationVersion: 2,
    }
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['t'] })
    expect(frozen.search('alpha').map(r => r.id)).toEqual(['a'])
    expect(frozen.search('gamma').map(r => r.id)).toEqual(['c'])
  })

  test('fromJSON loads an empty snapshot', () => {
    const snapshot = {
      documentCount: 0,
      nextId: 0,
      documentIds: {},
      fieldIds: { text: 0 },
      fieldLength: {},
      averageFieldLength: [0],
      storedFields: {},
      index: [],
      serializationVersion: 2,
    }
    const frozen = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] })
    expect(frozen.documentCount).toBe(0)
    expect(frozen.search('anything')).toEqual([])
  })

  test('fromJSON rejects unsupported serializationVersion', () => {
    const snapshot = validSnapshot({ serializationVersion: 99 })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/unsupported MiniSearch serializationVersion 99/)
  })

  test('fromJSON rejects fields that do not match the snapshot', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const json = JSON.stringify(reference)
    expect(() => FrozenMiniSearch.fromJSON(json, { fields: ['title'] }))
      .toThrow(/option "fields" must match/)
  })

  test('fromJSON rejects a non-integer posting docId key', () => {
    const snapshot = validSnapshot({
      index: [['hello', { 0: { oops: 1 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index term "hello" field 0 docId key "oops"/)
  })

  test('fromJSON rejects a partially numeric posting docId key', () => {
    const snapshot = validSnapshot({
      index: [['hello', { 0: { '0abc': 1 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index term "hello" field 0 docId key "0abc"/)
  })

  test('fromJSON rejects a posting docId outside nextId', () => {
    const snapshot = validSnapshot({
      index: [['hello', { 0: { 99: 1 } }]],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index term "hello" field 0 shortId 99 must be < nextId 1/)
  })

  test('fromJSON rejects malformed index entries', () => {
    const snapshot = validSnapshot({
      index: ['hello'],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index entry 0 must be a \[term, data\] pair/)
  })

  test('fromJSON rejects duplicate index terms', () => {
    const snapshot = validSnapshot({
      index: [
        ['hello', { 0: { 0: 1 } }],
        ['hello', { 0: { 0: 1 } }],
      ],
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: index term "hello" is duplicated/)
  })

  test('fromJSON rejects malformed documentIds keys', () => {
    const snapshot = validSnapshot({
      documentIds: { oops: 'a' },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: documentIds key "oops"/)
  })

  test('fromJSON rejects fieldIds outside the field count', () => {
    const snapshot = validSnapshot({
      fieldIds: { text: 1 },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: fieldIds.text must be < field count 1/)
  })

  test('fromJSON rejects malformed fieldLength rows', () => {
    const snapshot = validSnapshot({
      fieldLength: { 0: 1 },
    })
    expect(() => FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), { fields: ['text'] }))
      .toThrow(/invalid MiniSearch snapshot: fieldLength shortId 0 must be an array/)
  })

  test('fromJSON postings layout matches fromDocuments', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const fromJSON = FrozenMiniSearch.fromJSON(JSON.stringify(reference), options)
    const fromDocs = FrozenMiniSearch.fromDocuments(docs, options)

    expect(frozenMemoryBreakdown(fromJSON).postings).toEqual(frozenMemoryBreakdown(fromDocs).postings)
    expect(fromJSON.termCount).toBe(fromDocs.termCount)
    expect(fromJSON.search('zen art', { combineWith: 'AND' }).map(r => r.id))
      .toEqual(fromDocs.search('zen art', { combineWith: 'AND' }).map(r => r.id))
  })

  test('fromJSON frozen toJSON round-trip is deterministic and search-equivalent', () => {
    const direct = FrozenMiniSearch.fromDocuments(docs, options)
    const snapshot = JSON.stringify(direct.toJSON())
    const viaJsonA = FrozenMiniSearch.fromJSON(snapshot, options)
    const viaJsonB = FrozenMiniSearch.fromJSON(snapshot, options)
    const a = Buffer.from(viaJsonA.saveBinarySync())
    const b = Buffer.from(viaJsonB.saveBinarySync())
    expect(a.equals(b)).toBe(true)
    expect(viaJsonA.search('zen art', { combineWith: 'AND' }).map(r => r.id))
      .toEqual(direct.search('zen art', { combineWith: 'AND' }).map(r => r.id))
  })
})
