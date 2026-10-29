/* eslint-disable no-labels */
import { shouldPruneFuzzyEdge } from '../fuzzyLengthPrune'
import type PackedRadixTree from './PackedRadixTree'
import type { PackedTermPath } from './termPath'
import type { PackedFuzzyRef, PackedTermCursor } from './types'

const scratchMatrix = new Uint8Array(4096)
const scratchQueryCodes = new Uint16Array(256)
let scratchInUse = false

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
  visit: (
    termIndex: number,
    length: number,
    distance: number,
    cursor: PackedTermCursor,
  ) => void,
): void {
  if (maxDistance < 0) return

  const queryLen = query.length
  const n = queryLen + 1
  const m = n + maxDistance
  const needed = m * n

  const useSharedScratch = !scratchInUse
  if (useSharedScratch) scratchInUse = true

  const queryCodes =
    useSharedScratch && n <= scratchQueryCodes.length
      ? scratchQueryCodes
      : new Uint16Array(n)
  for (let j = 0; j < queryLen; j++) queryCodes[j] = query.charCodeAt(j)

  const heap = String(tree.labelHeap)
  const path = tree.termPaths.acquire('')

  try {
    if (maxDistance === 0) {
      walkExactSuffix(
        tree,
        heap,
        queryCodes,
        queryLen,
        0,
        0,
        0,
        0,
        0,
        path,
        visit,
      )
      return
    }

    const matrix =
      useSharedScratch && needed <= scratchMatrix.length
        ? scratchMatrix
        : new Uint8Array(needed)
    matrix.fill(maxDistance + 1, 0, needed)
    for (let j = 0; j < n; ++j) matrix[j] = j
    for (let i = 1; i < m; ++i) matrix[i * n] = i

    if (tree.nodeLeafOrder[0] !== 0 && queryLen <= maxDistance) {
      path.depth = 0
      visit(tree.nodeValue[0], 0, queryLen, path)
    }

    visitRecurse(
      tree,
      heap,
      queryLen,
      queryCodes,
      maxDistance,
      matrix,
      1,
      0,
      0,
      path,
      visit,
    )
  } finally {
    if (useSharedScratch) scratchInUse = false
    tree.termPaths.release(path)
  }
}

// Iterable wrapper; allocates refs[]. Query engine uses packedRadixVisitFuzzyRefs instead.
function* runFuzzy(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
): Generator<PackedFuzzyRef> {
  const refs: PackedFuzzyRef[] = []
  packedRadixVisitFuzzyRefs(
    tree,
    query,
    maxDistance,
    (termIndex, length, distance) => {
      refs.push({ termIndex, length, distance })
    },
  )
  yield* refs
}

/**
 * When a path reaches edit distance `maxDistance` with no remaining error budget,
 * any valid completion must match a remaining suffix `query[qPos..queryLen]` verbatim.
 */
function walkExactSuffix(
  tree: PackedRadixTree,
  heap: string,
  queryCodes: Uint16Array,
  queryLen: number,
  qPos: number,
  maxDistance: number,
  node: number,
  termLength: number,
  depth: number,
  path: PackedTermPath,
  visit: (
    termIndex: number,
    length: number,
    distance: number,
    cursor: PackedTermCursor,
  ) => void,
): void {
  let pos = qPos
  let curNode = node
  let curLen = termLength
  let curDepth = depth
  const nodeEdgeOffset = tree.nodeEdgeOffset
  const edgeLabelStart = tree.edgeLabelStart
  const edgeLabelLength = tree.edgeLabelLength
  const edgeChild = tree.edgeChild

  while (pos < queryLen) {
    const firstChar = queryCodes[pos]
    const end = nodeEdgeOffset[curNode + 1]
    let foundEi = -1
    for (let ei = nodeEdgeOffset[curNode]; ei < end; ei++) {
      if (heap.charCodeAt(edgeLabelStart[ei]) === firstChar) {
        foundEi = ei
        break
      }
    }
    if (foundEi < 0) return

    const labelStart = edgeLabelStart[foundEi]
    const labelLen = edgeLabelLength[foundEi]
    if (pos + labelLen > queryLen) return
    for (let k = 1; k < labelLen; k++) {
      if (heap.charCodeAt(labelStart + k) !== queryCodes[pos + k]) return
    }
    path.edges[curDepth] = foundEi
    curDepth++
    curLen += labelLen
    pos += labelLen
    curNode = edgeChild[foundEi]
  }

  if (tree.nodeLeafOrder[curNode] !== 0) {
    path.depth = curDepth
    visit(tree.nodeValue[curNode], curLen, maxDistance, path)
  }
}

function visitRecurse(
  tree: PackedRadixTree,
  heap: string,
  queryLen: number,
  queryCodes: Uint16Array,
  maxDistance: number,
  matrix: Uint8Array,
  rowStart: number,
  node: number,
  depth: number,
  path: PackedTermPath,
  visit: (
    termIndex: number,
    length: number,
    distance: number,
    cursor: PackedTermCursor,
  ) => void,
): void {
  const n = queryLen + 1
  const termLength = rowStart - 1
  const nodeEdgeOffset = tree.nodeEdgeOffset
  const edgeLabelStart = tree.edgeLabelStart
  const edgeLabelLength = tree.edgeLabelLength
  const edgeChild = tree.edgeChild

  const first = nodeEdgeOffset[node]
  const end = nodeEdgeOffset[node + 1]

  edge: for (let ei = first; ei < end; ei++) {
    const labelLen = edgeLabelLength[ei]
    if (shouldPruneFuzzyEdge(termLength, labelLen, queryLen, maxDistance)) {
      continue edge
    }

    const childTermLength = termLength + labelLen
    const labelStart = edgeLabelStart[ei]
    let i = rowStart
    let thisRowOffset = rowStart * n
    let minDistance = 0

    for (let pos = 0; pos < labelLen; ++pos) {
      const char = heap.charCodeAt(labelStart + pos)
      const prevRowOffset = thisRowOffset - n

      const jmin = i > maxDistance + 1 ? i - maxDistance - 1 : 0
      const jmax = i + maxDistance < queryLen ? i + maxDistance : queryLen

      let upLeft = matrix[prevRowOffset + jmin]
      let left = matrix[thisRowOffset + jmin]
      minDistance = left

      for (let j = jmin; j < jmax; ++j) {
        const up = matrix[prevRowOffset + j + 1]
        let dist = upLeft + (char === queryCodes[j] ? 0 : 1)
        if (up < dist) dist = up + 1
        if (left < dist) dist = left + 1
        upLeft = up
        left = dist
        matrix[thisRowOffset + j + 1] = dist
        if (dist < minDistance) minDistance = dist
      }

      if (minDistance > maxDistance) {
        continue edge
      }

      if (minDistance === maxDistance) {
        const remEdge = labelLen - 1 - pos
        const cMin = i > maxDistance ? i - maxDistance : 0
        const maxC = queryLen - remEdge
        const cMax = i + maxDistance < maxC ? i + maxDistance : maxC
        const child = edgeChild[ei]
        const nextDepth = depth + 1
        path.edges[depth] = ei

        col: for (let c = cMin; c <= cMax; c++) {
          if (matrix[thisRowOffset + c] !== maxDistance) continue
          for (let k = 0; k < remEdge; k++) {
            if (
              heap.charCodeAt(labelStart + pos + 1 + k) !== queryCodes[c + k]
            ) {
              continue col
            }
          }
          walkExactSuffix(
            tree,
            heap,
            queryCodes,
            queryLen,
            c + remEdge,
            maxDistance,
            child,
            childTermLength,
            nextDepth,
            path,
            visit,
          )
        }
        continue edge
      }

      ++i
      thisRowOffset += n
    }

    const child = edgeChild[ei]
    const nextDepth = depth + 1
    path.edges[depth] = ei

    if (tree.nodeLeafOrder[child] !== 0) {
      const distance = matrix[thisRowOffset - 1]
      if (distance <= maxDistance) {
        path.depth = nextDepth
        visit(tree.nodeValue[child], childTermLength, distance, path)
      }
    }

    if (
      nodeEdgeOffset[child] < nodeEdgeOffset[child + 1] &&
      !shouldPruneFuzzyEdge(childTermLength, 1, queryLen, maxDistance)
    ) {
      visitRecurse(
        tree,
        heap,
        queryLen,
        queryCodes,
        maxDistance,
        matrix,
        i,
        child,
        nextDepth,
        path,
        visit,
      )
    }
  }
}
