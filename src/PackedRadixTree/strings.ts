export type LabelSegment = { start: number, len: number }

export function labelSlice(heap: string, start: number, len: number): string {
  return heap.slice(start, start + len)
}

/** Rebuild a fuzzy-search path from heap label segments (used by fuzzy traversal only). */
export function buildTermFromSegments(heap: string, segments: LabelSegment[]): string {
  const depth = segments.length
  if (depth === 0) return ''
  if (depth === 1) return labelSlice(heap, segments[0].start, segments[0].len)
  let result = labelSlice(heap, segments[0].start, segments[0].len)
  for (let i = 1; i < depth; i++) {
    result += labelSlice(heap, segments[i].start, segments[i].len)
  }
  return result
}
