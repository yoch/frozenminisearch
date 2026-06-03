import { shouldPruneFuzzyEdge } from '../fuzzyLengthPrune'
import { decodeLeafSlot, edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import type PackedRadixTree from './PackedRadixTree'
import { buildTermFromSegmentArrays } from './strings'

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

  const queryLen = query.length
  const queryCodes = new Uint16Array(n)
  for (let j = 0; j < queryLen; j++) queryCodes[j] = query.charCodeAt(j)

  const segmentStarts = new Uint32Array(m)
  const segmentLens = new Uint32Array(m)

  recurse(
    tree,
    queryLen,
    queryCodes,
    maxDistance,
    results,
    matrix,
    1,
    0,
    segmentStarts,
    segmentLens,
    0,
  )

  return results
}

function recurse(
  tree: PackedRadixTree,
  queryLen: number,
  queryCodes: Uint16Array,
  maxDistance: number,
  results: Array<[string, number, number]>,
  matrix: Uint8Array,
  rowStart: number,
  node: number,
  segmentStarts: Uint32Array,
  segmentLens: Uint32Array,
  depth: number,
): void {
  const heap = tree.labelHeap
  const n = queryLen + 1
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
        results.push([buildTermFromSegmentArrays(heap, segmentStarts, segmentLens, depth), tree.nodeValue[node], distance])
      }
      continue
    }

    const ei = first + edgeOffset
    const labelStart = tree.edgeLabelStart[ei]
    const labelLen = tree.edgeLabelLength[ei]
    if (shouldPruneFuzzyEdge(rowStart - 1, labelLen, queryLen, maxDistance)) {
      continue edge
    }

    let i = rowStart
    let thisRowOffset = rowStart * n

    for (let pos = 0; pos < labelLen; ++pos, ++i, thisRowOffset += n) {
      const char = heap.charCodeAt(labelStart + pos)
      const prevRowOffset = thisRowOffset - n

      let minDistance = matrix[thisRowOffset]

      // Keep Math.max/min: V8 inlines two-arg min/max well; manual ternaries showed no gain.
      const jmin = Math.max(0, i - maxDistance - 1)
      const jmax = Math.min(queryLen, i + maxDistance)

      for (let j = jmin; j < jmax; ++j) {
        const different = char === queryCodes[j] ? 0 : 1

        const rpl = matrix[prevRowOffset + j] + different
        const del = matrix[prevRowOffset + j + 1] + 1
        const ins = matrix[thisRowOffset + j] + 1

        let dist = rpl
        if (del < dist) dist = del
        if (ins < dist) dist = ins
        matrix[thisRowOffset + j + 1] = dist

        if (dist < minDistance) minDistance = dist
      }

      if (minDistance > maxDistance) {
        continue edge
      }
    }

    segmentStarts[depth] = labelStart
    segmentLens[depth] = labelLen
    recurse(
      tree,
      queryLen,
      queryCodes,
      maxDistance,
      results,
      matrix,
      i,
      tree.edgeChild[ei],
      segmentStarts,
      segmentLens,
      depth + 1,
    )
  }
}
