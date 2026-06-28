/**
 * Dev/bench-only string iterators for PackedRadixTree. Not imported on the product
 * build path — keeps `prefixEntries`-style APIs out of published bundles.
 */
import type PackedRadixTree from './PackedRadixTree'
import { labelSlice } from './strings'
import { emitSubtree } from './stringEmit'

function labelsMatch(heap: string, start: number, len: number, key: string, keyOff: number): boolean {
  for (let i = 0; i < len; i++) {
    if (heap.charCodeAt(start + i) !== key.charCodeAt(keyOff + i)) return false
  }
  return true
}

function findEdge(tree: PackedRadixTree, node: number, firstChar: number): number {
  const end = tree.nodeEdgeOffset[node + 1]
  const heap = tree.labelHeap
  for (let ei = tree.nodeEdgeOffset[node]; ei < end; ei++) {
    if (heap.charCodeAt(tree.edgeLabelStart[ei]) === firstChar) return ei
  }
  return -1
}

function resolvePrefixWalk(tree: PackedRadixTree, prefix: string): { node: number, prefix: string } | null {
  if (prefix.length === 0) {
    return { node: 0, prefix: '' }
  }

  let node = 0
  let prefixStr = ''
  let pos = 0
  const heap = tree.labelHeap
  const n = prefix.length

  while (pos < n) {
    const ei = findEdge(tree, node, prefix.charCodeAt(pos))
    if (ei < 0) return null

    const start = tree.edgeLabelStart[ei]
    const len = tree.edgeLabelLength[ei]
    const remaining = n - pos

    if (remaining < len) {
      if (!labelsMatch(heap, start, remaining, prefix, pos)) return null
      prefixStr += labelSlice(heap, start, len)
      return { node: tree.edgeChild[ei], prefix: prefixStr }
    }

    if (!labelsMatch(heap, start, len, prefix, pos)) return null
    prefixStr += labelSlice(heap, start, len)
    pos += len
    node = tree.edgeChild[ei]
  }

  return { node, prefix: prefixStr }
}

/** @deprecated Dev/bench helper. Prefer `prefixRefs` + `termByIndex` in production code. */
export function* packedPrefixEntries(
  tree: PackedRadixTree,
  prefix: string,
): IterableIterator<[string, number]> {
  const start = resolvePrefixWalk(tree, prefix)
  if (start == null) return
  yield* emitSubtree(tree, start.node, start.prefix)
}
