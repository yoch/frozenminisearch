import {
  SEEK_ALLOWED_MIN_LIST_LENGTH,
  findDocIndexInSortedSegment,
  shouldSeekAllowedDocs,
} from './compactPostings'

describe('sorted segment seek helpers', () => {
  test('findDocIndexInSortedSegment locates doc ids', () => {
    const docIds = Uint32Array.from([10, 20, 30, 40])
    expect(findDocIndexInSortedSegment(docIds, 0, 4, 10)).toBe(0)
    expect(findDocIndexInSortedSegment(docIds, 0, 4, 25)).toBe(-1)
    expect(findDocIndexInSortedSegment(docIds, 1, 2, 30)).toBe(2)
  })

  test('shouldSeekAllowedDocs matches calibrated ratio rule', () => {
    expect(shouldSeekAllowedDocs(11111, 50000)).toBe(true)
    expect(shouldSeekAllowedDocs(10000, 10000)).toBe(false)
    expect(shouldSeekAllowedDocs(100, 10000)).toBe(true)
    expect(shouldSeekAllowedDocs(1, 100)).toBe(false)
    expect(shouldSeekAllowedDocs(1, 2048)).toBe(true)
    expect(shouldSeekAllowedDocs(1, 1024)).toBe(false)
    expect(SEEK_ALLOWED_MIN_LIST_LENGTH).toBe(2048)
  })
})
