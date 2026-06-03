import { shouldPruneFuzzyEdge } from '../fuzzyLengthPrune'
import { decodeLeafSlot, edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import type PackedRadixTree from './PackedRadixTree'
import { buildTermFromSegments, type LabelSegment } from './strings'

export function packedRadixFuzzyEntries(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
): Iterable<[string, number, number]> {
  const results: Array<[string, number, number]> = []
  if (maxDistance < 0) return results

  const n = query.length + 1
  const m = n + maxDistance
  const matrix = new Uint8Array(m * n).fill(maxDistance + 1)
  for (let j = 0; j < n; ++j) matrix[j] = j
  for (let i = 1; i < m; ++i) matrix[i * n] = i

  const segments: LabelSegment[] = []

  recurse(
    tree,
    query,
    maxDistance,
    results,
    matrix,
    1,
    n,
    0,
    segments,
  )

  return results
}

function recurse(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
  results: Array<[string, number, number]>,
  matrix: Uint8Array,
  rowStart: number,
  n: number,
  node: number,
  segments: LabelSegment[],
): void {
  const heap = tree.labelHeap
  const offset = rowStart * n

  const first = tree.nodeEdgeOffset[node]
  const edgeCount = tree.nodeEdgeOffset[node + 1] - first
  const leafSlot = decodeLeafSlot(tree.nodeLeafOrder[node])
  const totalCount = packedNodeChildCount(edgeCount, leafSlot >= 0)

  edge: for (let slot = 0; slot < totalCount; slot++) {
    const edgeOffset = edgeOffsetAtSlot(slot, leafSlot)
    if (edgeOffset < 0) {
      const distance = matrix[offset - 1]
      if (distance <= maxDistance) {
        results.push([buildTermFromSegments(heap, segments), tree.nodeValue[node], distance])
      }
      continue
    }

    const ei = first + edgeOffset
    const labelStart = tree.edgeLabelStart[ei]
    const labelLen = tree.edgeLabelLength[ei]
    if (shouldPruneFuzzyEdge(rowStart - 1, labelLen, query.length, maxDistance)) {
      continue edge
    }

    let i = rowStart

    for (let pos = 0; pos < labelLen; ++pos, ++i) {
      const char = heap.charCodeAt(labelStart + pos)
      const thisRowOffset = n * i
      const prevRowOffset = thisRowOffset - n

      let minDistance = matrix[thisRowOffset]

      const jmin = Math.max(0, i - maxDistance - 1)
      const jmax = Math.min(n - 1, i + maxDistance)

      for (let j = jmin; j < jmax; ++j) {
        const different = char !== query.charCodeAt(j)

        // Manual Math.min for better performance in the inner loop
        let dist = matrix[prevRowOffset + j]
        if (different) dist++

        const del = matrix[prevRowOffset + j + 1] + 1
        if (del < dist) dist = del

        const ins = matrix[thisRowOffset + j] + 1
        if (ins < dist) dist = ins

        matrix[thisRowOffset + j + 1] = dist
        if (dist < minDistance) minDistance = dist
      }

      if (minDistance > maxDistance) {
        continue edge
      }
    }

    segments.push({ start: labelStart, len: labelLen })
    recurse(
      tree,
      query,
      maxDistance,
      results,
      matrix,
      i,
      n,
      tree.edgeChild[ei],
      segments,
    )
    segments.pop()
  }
}
