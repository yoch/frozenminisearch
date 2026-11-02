/* eslint-disable no-labels */
import { shouldPruneFuzzyEdge } from '../fuzzyLengthPrune'
import {
  decodeLeafSlot,
  edgeOffsetAtSlot,
  packedNodeChildCount,
} from './layout'
import type PackedRadixTree from './PackedRadixTree'
import type { PackedTermPath } from './termPath'
import type { PackedTermCursor } from './types'

type MatrixVisit = (
  termIndex: number,
  length: number,
  distance: number,
  cursor: PackedTermCursor,
) => void

type MatrixSearch = {
  tree: PackedRadixTree
  queryLen: number
  queryCodes: Uint16Array
  maxDistance: number
  matrix: Uint8Array
  path: PackedTermPath
  visit: MatrixVisit
}

/** Banded Levenshtein matrix traversal, for queries too long for bit masks. */
export function visitFuzzyRefsByMatrix(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
  visit: MatrixVisit,
): void {
  const n = query.length + 1
  const m = n + maxDistance
  const matrix = new Uint8Array(m * n).fill(maxDistance + 1)
  for (let j = 0; j < n; ++j) matrix[j] = j
  for (let i = 1; i < m; ++i) matrix[i * n] = i

  const queryLen = query.length
  const queryCodes = new Uint16Array(n)
  for (let j = 0; j < queryLen; j++) queryCodes[j] = query.charCodeAt(j)

  const path = tree.termPaths.acquire('')
  const search: MatrixSearch = {
    tree,
    queryLen,
    queryCodes,
    maxDistance,
    matrix,
    path,
    visit,
  }
  try {
    visitRecurse(search, 1, 0, 0, 0)
  } finally {
    tree.termPaths.release(path)
  }
}

function visitRecurse(
  search: MatrixSearch,
  rowStart: number,
  node: number,
  termLength: number,
  depth: number,
): void {
  const { tree, queryLen, queryCodes, maxDistance, matrix, path } = search
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
        path.depth = depth
        search.visit(tree.nodeValue[node], termLength, distance, path)
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

    path.edges[depth] = ei
    visitRecurse(
      search,
      i,
      tree.edgeChild[ei],
      termLength + labelLen,
      depth + 1,
    )
  }
}
