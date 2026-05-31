export type LabelSegment = { start: number, len: number }

export function labelSlice(heap: string, start: number, len: number): string {
  return heap.slice(start, start + len)
}

export function buildTermFromSegments(heap: string, segments: LabelSegment[]): string {
  if (segments.length === 0) return ''
  let out = ''
  for (const seg of segments) {
    out += labelSlice(heap, seg.start, seg.len)
  }
  return out
}
