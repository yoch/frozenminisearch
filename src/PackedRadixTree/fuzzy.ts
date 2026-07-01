/* eslint-disable no-labels */
import { shouldPruneFuzzyEdge } from '../fuzzyLengthPrune'
import { decodeLeafSlot, edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import type PackedRadixTree from './PackedRadixTree'
import type { PackedFuzzyRef } from './types'

export function packedRadixFuzzyRefs(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
): Iterable<PackedFuzzyRef> {
  return runFuzzy(tree, query, maxDistance)
}

export function packedRadixVisitFuzzyRefs(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
  visit: (termIndex: number, length: number, distance: number) => void,
): void {
  if (maxDistance < 0) return

  const n = query.length + 1
  const m = n + maxDistance
  const matrix = new Uint8Array(m * n).fill(maxDistance + 1)
  for (let j = 0; j < n; ++j) matrix[j] = j
  for (let i = 1; i < m; ++i) matrix[i * n] = i

  const queryLen = query.length
  const queryCodes = new Uint16Array(n)
  for (let j = 0; j < queryLen; j++) queryCodes[j] = query.charCodeAt(j)

  visitRecurse(
    tree,
    queryLen,
    queryCodes,
    maxDistance,
    matrix,
    1,
    0,
    0,
    visit,
  )
}

// Iterable wrapper; allocates refs[]. Query engine uses packedRadixVisitFuzzyRefs instead.
function* runFuzzy(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
): Generator<PackedFuzzyRef> {
  const refs: PackedFuzzyRef[] = []
  packedRadixVisitFuzzyRefs(tree, query, maxDistance, (termIndex, length, distance) => {
    refs.push({ termIndex, length, distance })
  })
  yield* refs
}

function visitRecurse(
  tree: PackedRadixTree,
  queryLen: number,
  queryCodes: Uint16Array,
  maxDistance: number,
  matrix: Uint8Array,
  rowStart: number,
  node: number,
  termLength: number,
  visit: (termIndex: number, length: number, distance: number) => void,
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
        visit(tree.nodeValue[node], termLength, distance)
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

    visitRecurse(
      tree,
      queryLen,
      queryCodes,
      maxDistance,
      matrix,
      i,
      tree.edgeChild[ei],
      termLength + labelLen,
      visit,
    )
  }
}
