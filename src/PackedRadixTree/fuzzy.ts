/* eslint-disable no-labels */
import { shouldPruneFuzzyEdge } from '../fuzzyLengthPrune'
import { visitFuzzyRefsByMatrix } from './fuzzyMatrix'
import type PackedRadixTree from './PackedRadixTree'
import type { PackedTermPath } from './termPath'
import type { PackedFuzzyRef, PackedTermCursor } from './types'

type FuzzyVisit = (
  termIndex: number,
  length: number,
  distance: number,
  cursor: PackedTermCursor,
) => void

/** State masks need `queryLen + 1` bits and must stay clear of the int32 sign bit. */
const MAX_BIT_QUERY_LENGTH = 30

const scratchPeq = new Int32Array(256)
const scratchStates = new Int32Array(1024)
const scratchQueryCodes = new Uint16Array(MAX_BIT_QUERY_LENGTH)
const scratchWideCodes: number[] = []
const scratchWideMasks: number[] = []
let scratchInUse = false

type BitSearch = {
  tree: PackedRadixTree
  heap: string
  queryCodes: Uint16Array
  queryLen: number
  maxDistance: number
  width: number
  full: number
  accept: number
  peq: Int32Array
  wideCodes: number[]
  wideMasks: number[]
  states: Int32Array
  path: PackedTermPath
  visit: FuzzyVisit
}

export function packedRadixFuzzyRefs(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
): Iterable<PackedFuzzyRef> {
  return runFuzzy(tree, query, maxDistance)
}

/**
 * Visits every term within `maxDistance` edits of `query`, in tree order (a
 * node's leaf keeps its slot among the sibling edges). Bit-parallel Levenshtein
 * automaton (Wu-Manber): bit `j` of state mask `k` means the query prefix of
 * length `j` is reached with at most `k` edits.
 */
export function packedRadixVisitFuzzyRefs(
  tree: PackedRadixTree,
  query: string,
  maxDistance: number,
  visit: FuzzyVisit,
): void {
  if (maxDistance < 0) return
  const queryLen = query.length
  // Non-integer distances keep MiniSearch's matrix behaviour.
  if (queryLen > MAX_BIT_QUERY_LENGTH || !Number.isInteger(maxDistance)) {
    visitFuzzyRefsByMatrix(tree, query, maxDistance, visit)
    return
  }

  const width = maxDistance + 1
  const stateCount = (queryLen + maxDistance + 2) * width
  const useScratch = !scratchInUse
  const peq = useScratch ? scratchPeq : new Int32Array(256)
  const states =
    useScratch && stateCount <= scratchStates.length
      ? scratchStates
      : new Int32Array(stateCount)

  const queryCodes = useScratch ? scratchQueryCodes : new Uint16Array(queryLen)
  const wideCodes: number[] = useScratch ? scratchWideCodes : []
  const wideMasks: number[] = useScratch ? scratchWideMasks : []
  for (let j = 0; j < queryLen; j++) {
    const c = query.charCodeAt(j)
    queryCodes[j] = c
    if (c < 256) {
      peq[c] |= 1 << (j + 1)
      continue
    }
    const at = wideCodes.indexOf(c)
    if (at < 0) {
      wideCodes.push(c)
      wideMasks.push(1 << (j + 1))
    } else {
      wideMasks[at] |= 1 << (j + 1)
    }
  }

  const full = ((1 << (queryLen + 1)) - 1) | 0
  for (let k = 0; k < width; k++) {
    states[k] = k >= queryLen ? full : (1 << (k + 1)) - 1
  }

  const path = tree.termPaths.acquire('')
  const search: BitSearch = {
    tree,
    heap: String(tree.labelHeap),
    queryCodes,
    queryLen,
    maxDistance,
    width,
    full,
    accept: 1 << queryLen,
    peq,
    wideCodes,
    wideMasks,
    states,
    path,
    visit,
  }
  if (useScratch) scratchInUse = true
  try {
    if (maxDistance === 0) walkExactSingle(search, 0, 0, 0, 0)
    else visitBits(search, 0, 0, 0)
  } finally {
    for (let j = 0; j < queryLen; j++) {
      if (queryCodes[j] < 256) peq[queryCodes[j]] = 0
    }
    wideCodes.length = 0
    wideMasks.length = 0
    if (useScratch) scratchInUse = false
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

function peqOf(search: BitSearch, c: number): number {
  if (c < 256) return search.peq[c]
  const at = search.wideCodes.indexOf(c)
  return at < 0 ? 0 : search.wideMasks[at]
}

function visitLeafAtRow(
  search: BitSearch,
  row: number,
  node: number,
  depth: number,
): void {
  const { states, width, accept } = search
  for (let k = 0; k < width; k++) {
    if ((states[row * width + k] & accept) !== 0) {
      search.path.depth = depth
      search.visit(search.tree.nodeValue[node], row, k, search.path)
      return
    }
  }
}

function visitBits(
  search: BitSearch,
  node: number,
  row: number,
  depth: number,
): void {
  const { tree, heap, states, width, full, queryLen, maxDistance, path, peq } =
    search
  const nodeEdgeOffset = tree.nodeEdgeOffset
  const edgeLabelStart = tree.edgeLabelStart
  const edgeLabelLength = tree.edgeLabelLength
  const edgeChild = tree.edgeChild

  const first = nodeEdgeOffset[node]
  const end = nodeEdgeOffset[node + 1]
  const leafOrder = tree.nodeLeafOrder[node]
  const leafEi = leafOrder === 0 ? -1 : first + leafOrder - 1

  edge: for (let ei = first; ei < end; ei++) {
    if (ei === leafEi) visitLeafAtRow(search, row, node, depth)

    const labelLen = edgeLabelLength[ei]
    if (shouldPruneFuzzyEdge(row, labelLen, queryLen, maxDistance)) continue

    const labelStart = edgeLabelStart[ei]
    let r = row
    for (let pos = 0; pos < labelLen; pos++) {
      const c = heap.charCodeAt(labelStart + pos)
      const b = c < 256 ? peq[c] : peqOf(search, c)
      const src = r * width
      const dst = src + width
      let lower = (states[src] << 1) & b
      states[dst] = lower
      for (let k = 1; k < width; k++) {
        const prevLower = states[src + k - 1]
        lower =
          (((states[src + k] << 1) & b) |
            prevLower |
            (prevLower << 1) |
            (lower << 1)) &
          full
        states[dst + k] = lower
      }
      r++
      if (lower === 0) continue edge

      if (states[dst + maxDistance - 1] === 0) {
        let mask = lower
        for (let p = pos + 1; p < labelLen; p++) {
          mask = (mask << 1) & peqOf(search, heap.charCodeAt(labelStart + p))
          if (mask === 0) continue edge
        }
        path.edges[depth] = ei
        walkExactMask(search, mask, edgeChild[ei], row + labelLen, depth + 1)
        continue edge
      }
    }

    const child = edgeChild[ei]
    path.edges[depth] = ei
    if (
      nodeEdgeOffset[child] === nodeEdgeOffset[child + 1] ||
      shouldPruneFuzzyEdge(r, 1, queryLen, maxDistance)
    ) {
      if (tree.nodeLeafOrder[child] !== 0) {
        visitLeafAtRow(search, r, child, depth + 1)
      }
    } else {
      visitBits(search, child, r, depth + 1)
    }
  }

  if (leafEi === end) visitLeafAtRow(search, row, node, depth)
}

/**
 * The error budget is spent: every surviving bit of `mask` must now match the
 * rest of the query verbatim. Visits matches in tree order.
 */
function walkExactMask(
  search: BitSearch,
  mask: number,
  node: number,
  termLength: number,
  depth: number,
): void {
  const { tree, heap, path } = search
  const nodeEdgeOffset = tree.nodeEdgeOffset
  const edgeLabelStart = tree.edgeLabelStart
  const edgeLabelLength = tree.edgeLabelLength

  // Usually at most one offset survives: checking each is cheaper than the ordered scan.
  let single = -1
  for (let rest = mask; rest !== 0;) {
    const low = rest & -rest
    rest ^= low
    const qPos = 31 - Math.clz32(low)
    if (!exactSuffixMatches(search, qPos, node)) continue
    if (single >= 0) {
      single = -2
      break
    }
    single = qPos
  }
  if (single === -1) return
  if (single >= 0) {
    walkExactSingle(search, single, node, termLength, depth)
    return
  }

  const first = nodeEdgeOffset[node]
  const end = nodeEdgeOffset[node + 1]
  const leafOrder = tree.nodeLeafOrder[node]
  const leafEi =
    leafOrder !== 0 && (mask & search.accept) !== 0 ? first + leafOrder - 1 : -1

  edge: for (let ei = first; ei <= end; ei++) {
    if (ei === leafEi) {
      path.depth = depth
      search.visit(tree.nodeValue[node], termLength, search.maxDistance, path)
    }
    if (ei === end) break
    const labelStart = edgeLabelStart[ei]
    const labelLen = edgeLabelLength[ei]
    let m = mask
    for (let p = 0; p < labelLen; p++) {
      m = (m << 1) & peqOf(search, heap.charCodeAt(labelStart + p))
      if (m === 0) continue edge
    }
    path.edges[depth] = ei
    walkExactMask(
      search,
      m,
      tree.edgeChild[ei],
      termLength + labelLen,
      depth + 1,
    )
  }
}

function exactSuffixMatches(
  search: BitSearch,
  qPos: number,
  node: number,
): boolean {
  const { tree, heap, queryCodes, queryLen } = search
  const nodeEdgeOffset = tree.nodeEdgeOffset
  const edgeLabelStart = tree.edgeLabelStart
  const edgeLabelLength = tree.edgeLabelLength
  let pos = qPos
  let curNode = node
  outer: while (pos < queryLen) {
    const firstChar = queryCodes[pos]
    const end = nodeEdgeOffset[curNode + 1]
    for (let ei = nodeEdgeOffset[curNode]; ei < end; ei++) {
      const labelStart = edgeLabelStart[ei]
      if (heap.charCodeAt(labelStart) !== firstChar) continue
      const labelLen = edgeLabelLength[ei]
      if (pos + labelLen > queryLen) return false
      for (let k = 1; k < labelLen; k++) {
        if (heap.charCodeAt(labelStart + k) !== queryCodes[pos + k]) {
          return false
        }
      }
      pos += labelLen
      curNode = tree.edgeChild[ei]
      continue outer
    }
    return false
  }
  return tree.nodeLeafOrder[curNode] !== 0
}

/** Single surviving offset: at most one sibling edge can match, so walk straight down. */
function walkExactSingle(
  search: BitSearch,
  qPos: number,
  node: number,
  termLength: number,
  depth: number,
): void {
  const { tree, heap, queryCodes, queryLen, path } = search
  const nodeEdgeOffset = tree.nodeEdgeOffset
  const edgeLabelStart = tree.edgeLabelStart
  const edgeLabelLength = tree.edgeLabelLength
  const edgeChild = tree.edgeChild
  let pos = qPos
  let curNode = node
  let curLen = termLength
  let curDepth = depth

  outer: while (pos < queryLen) {
    const firstChar = queryCodes[pos]
    const end = nodeEdgeOffset[curNode + 1]
    for (let ei = nodeEdgeOffset[curNode]; ei < end; ei++) {
      const labelStart = edgeLabelStart[ei]
      if (heap.charCodeAt(labelStart) !== firstChar) continue
      const labelLen = edgeLabelLength[ei]
      if (pos + labelLen > queryLen) return
      for (let k = 1; k < labelLen; k++) {
        if (heap.charCodeAt(labelStart + k) !== queryCodes[pos + k]) return
      }
      path.edges[curDepth++] = ei
      curLen += labelLen
      pos += labelLen
      curNode = edgeChild[ei]
      continue outer
    }
    return
  }

  if (tree.nodeLeafOrder[curNode] !== 0) {
    path.depth = curDepth
    search.visit(tree.nodeValue[curNode], curLen, search.maxDistance, path)
  }
}
