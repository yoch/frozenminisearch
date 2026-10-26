import { DocIdBitSet } from './docIdBitSet'

describe('DocIdBitSet', () => {
  test('tracks membership and size across word boundaries', () => {
    const set = new DocIdBitSet(100)
    for (const docId of [99, 31, 0, 32, 63, 31]) set.add(docId)
    expect(set.size).toBe(5)
    expect([0, 31, 32, 63, 99].every((docId) => set.has(docId))).toBe(true)
    expect(set.has(1)).toBe(false)
    expect(set.delete(31)).toBe(true)
    expect(set.delete(31)).toBe(false)
    expect(set.size).toBe(4)
    expect(Array.from(set)).toEqual([0, 32, 63, 99])
  })

  test('caches the ascending ids until the next change', () => {
    const set = new DocIdBitSet(64)
    set.add(40).add(3)
    const ids = set.toArray()
    expect(Array.from(ids)).toEqual([3, 40])
    expect(set.toArray()).toBe(ids)
    set.add(3)
    expect(set.toArray()).toBe(ids)
    set.add(10)
    expect(Array.from(set.toArray())).toEqual([3, 10, 40])
    expect(Array.from(ids)).toEqual([3, 40])
  })

  test('combines word by word like set operations, keeping the size', () => {
    const limit = 200
    const left = new DocIdBitSet(limit)
    const right = new DocIdBitSet(limit)
    const leftIds = new Set()
    const rightIds = new Set()
    for (let docId = 0; docId < limit; docId++) {
      if (docId % 3 === 0 || docId === 31 || docId === 199) {
        left.add(docId)
        leftIds.add(docId)
      }
      if (docId % 4 === 0 || docId === 31 || docId === 63) {
        right.add(docId)
        rightIds.add(docId)
      }
    }
    const copy = (ids) => {
      const set = new DocIdBitSet(limit)
      for (const docId of ids) set.add(docId)
      return set
    }
    const expectIds = (set, ids) => {
      expect(Array.from(set)).toEqual(Array.from(ids).sort((a, b) => a - b))
      expect(set.size).toBe(ids.length)
    }
    const union = copy(leftIds)
    union.or(right)
    expectIds(union, [...new Set([...leftIds, ...rightIds])])
    const intersection = copy(leftIds)
    intersection.and(right)
    expectIds(
      intersection,
      [...leftIds].filter((docId) => rightIds.has(docId)),
    )
    const difference = copy(leftIds)
    difference.toArray()
    difference.andNot(right)
    expectIds(
      difference,
      [...leftIds].filter((docId) => !rightIds.has(docId)),
    )
  })

  test('rejects ids at or above the limit', () => {
    const set = new DocIdBitSet(40)
    for (const docId of [40, 63, 64, -1])
      expect(() => set.add(docId)).toThrow(RangeError)
    expect(set.size).toBe(0)
    set.add(39)
    expect(Array.from(set)).toEqual([39])
  })

  test('can delete while it is iterated, as an intersection does', () => {
    const set = new DocIdBitSet(1000)
    for (let docId = 0; docId < 1000; docId += 3) set.add(docId)
    for (const docId of set) {
      if (docId % 2 !== 0) set.delete(docId)
    }
    expect(Array.from(set)).toEqual(
      Array.from({ length: 167 }, (_, i) => i * 6),
    )
    expect(set.size).toBe(167)
  })
})
