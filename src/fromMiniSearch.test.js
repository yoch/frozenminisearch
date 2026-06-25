import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title'],
  searchOptions: { prefix: true },
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

  test('fromMiniSearch instance uses toJSON()', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const frozen = FrozenMiniSearch._fromMiniSearch(reference, options)
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
    const snapshot = {
      documentCount: 1,
      nextId: 1,
      documentIds: { 0: 'a' },
      fieldIds: { text: 0 },
      fieldLength: { 0: [1] },
      averageFieldLength: [1],
      storedFields: {},
      index: [['hello', { 0: { 0: 1 } }]],
      serializationVersion: 99,
    }
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
})
