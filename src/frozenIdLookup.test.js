import { createIdToShortIdLookup } from './frozenIdLookup'

describe('createIdToShortIdLookup', () => {
  test('uses identity mode for contiguous numeric ids', () => {
    const lookup = createIdToShortIdLookup([0, 1, 2], 3)

    expect(lookup.mode).toBe('identity')
    expect(lookup.mapEntryCount).toBe(0)
    expect(lookup.has(1)).toBe(true)
    expect(lookup.get(1)).toBe(1)
    expect(lookup.has(3)).toBe(false)
    expect(lookup.get(3)).toBeUndefined()
    expect(lookup.has(1.5)).toBe(false)
    expect(lookup.get(-1)).toBeUndefined()
  })

  test('uses lazy-map mode for arbitrary external ids', () => {
    const objectId = { slug: 'c' }
    const lookup = createIdToShortIdLookup(['alpha', 42, objectId], 3)

    expect(lookup.mode).toBe('lazy-map')
    expect(lookup.mapEntryCount).toBe(0)
    expect(lookup.has('alpha')).toBe(true)
    expect(lookup.get('alpha')).toBe(0)
    expect(lookup.mapEntryCount).toBe(3)
    expect(lookup.get(42)).toBe(1)
    expect(lookup.get(objectId)).toBe(2)
    expect(lookup.get({ slug: 'c' })).toBeUndefined()
    expect(lookup.has('missing')).toBe(false)
  })

  test('skips undefined external id slots in lazy-map mode', () => {
    const lookup = createIdToShortIdLookup([undefined, 'kept'], 2)

    expect(lookup.mode).toBe('lazy-map')
    expect(lookup.has('kept')).toBe(true)
    expect(lookup.get('kept')).toBe(1)
    expect(lookup.mapEntryCount).toBe(1)
    expect(lookup.has(undefined)).toBe(false)
  })

  test('supports empty corpora in identity mode', () => {
    const lookup = createIdToShortIdLookup([], 0)

    expect(lookup.mode).toBe('identity')
    expect(lookup.has(0)).toBe(false)
    expect(lookup.get(0)).toBeUndefined()
  })
})
