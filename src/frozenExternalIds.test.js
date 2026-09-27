import FrozenMiniSearch from './FrozenMiniSearch'
import { frozenMemoryBreakdown } from '../testSupport/frozenMemoryBreakdown.js'
import { compactExternalIds, externalIdResolver, materializeExternalIds } from './frozenExternalIds'
import { createIdToShortIdLookup } from './frozenIdLookup'

describe('frozenExternalIds', () => {
  test('identity lookups drop the id array and resolve shortIds to themselves', () => {
    const ids = [0, 1, 2]
    const compact = compactExternalIds(ids, createIdToShortIdLookup(ids, 3))
    expect(compact).toBeNull()
    expect(externalIdResolver(compact)(2)).toBe(2)
    expect(materializeExternalIds(compact, 3)).toEqual(ids)
  })

  test('non-identity lookups keep the id array', () => {
    const ids = ['a', 'b']
    const compact = compactExternalIds(ids, createIdToShortIdLookup(ids, 2))
    expect(compact).toBe(ids)
    expect(externalIdResolver(compact)(1)).toBe('b')
    expect(materializeExternalIds(compact, 2)).toBe(ids)
  })

  test('negative zero id is not treated as identity', () => {
    expect(createIdToShortIdLookup([-0, 1], 2).mode).toBe('lazy-map')
  })
})

describe('FrozenMiniSearch with identity ids', () => {
  const docs = [
    { id: 0, txt: 'alpha beta' },
    { id: 1, txt: 'beta gamma' },
    { id: 2, txt: 'gamma alpha' },
  ]
  const opts = { fields: ['txt'], storeFields: ['txt'] }

  test('retains no external id slots and still reports original ids', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, opts)
    expect(frozenMemoryBreakdown(index).documents.idLookupMode).toBe('identity')
    expect(frozenMemoryBreakdown(index).documents.externalIdsSlots).toBe(0)
    expect(index.search('alpha').map(r => r.id).sort()).toEqual([0, 2])
    expect(index.search(FrozenMiniSearch.wildcard).map(r => r.id).sort()).toEqual([0, 1, 2])
    expect(index.autoSuggest('gam').length).toBeGreaterThan(0)
  })

  test.each(['raw', 'zlib'])('%s binary round-trip keeps identity ids', (compression) => {
    const index = FrozenMiniSearch.fromDocuments(docs, opts)
    const loaded = FrozenMiniSearch.loadBinarySync(index.saveBinarySync({ compression }), opts)
    expect(frozenMemoryBreakdown(loaded).documents.externalIdsSlots).toBe(0)
    expect(loaded.search('beta').map(r => r.id).sort()).toEqual([0, 1])
    expect(loaded.getStoredFields(2)).toEqual({ txt: 'gamma alpha' })
  })

  test('JSON round-trip keeps identity ids', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, opts)
    const json = JSON.stringify(index)
    expect(Object.values(JSON.parse(json).documentIds)).toEqual([0, 1, 2])
    const loaded = FrozenMiniSearch.fromJSON(json, opts)
    expect(loaded.search('gamma').map(r => r.id).sort()).toEqual([1, 2])
  })

  test('negative zero id survives search', () => {
    const index = FrozenMiniSearch.fromDocuments([{ id: -0, txt: 'x' }, { id: 1, txt: 'x' }], opts)
    const hit = index.search('x').find(r => r.id === 0)
    expect(Object.is(hit.id, -0)).toBe(true)
  })
})
