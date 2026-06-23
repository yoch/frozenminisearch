import {
  buildTermFromSegmentArrays,
  buildTermFromSegments,
  labelSlice,
} from './strings'

describe('PackedRadixTree string segment helpers', () => {
  test('rebuilds a term from non-contiguous heap segments', () => {
    const heap = '--alpha--bet--'

    expect(buildTermFromSegments(heap, [
      { start: 2, len: 5 },
      { start: 9, len: 3 },
    ])).toBe('alphabet')
  })

  test('rebuilds a term from reusable segment arrays up to the active depth', () => {
    const heap = '--alpha--bet--stale'
    const starts = new Uint32Array([2, 9, 14])
    const lens = new Uint32Array([5, 3, 5])

    expect(buildTermFromSegmentArrays(heap, starts, lens, 2)).toBe('alphabet')
  })

  test('handles empty and single-segment traversal paths', () => {
    const heap = 'prefix'

    expect(buildTermFromSegments(heap, [])).toBe('')
    expect(buildTermFromSegmentArrays(heap, new Uint32Array(0), new Uint32Array(0), 0)).toBe('')
    expect(labelSlice(heap, 3, 3)).toBe('fix')
    expect(buildTermFromSegments(heap, [{ start: 0, len: 3 }])).toBe('pre')
    expect(buildTermFromSegmentArrays(heap, new Uint32Array([0]), new Uint32Array([3]), 1)).toBe('pre')
  })
})
