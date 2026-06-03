import { decodeLeafSlot, packedIndexArray } from './layout'
import { labelSlice } from './strings'
import type { PackedIndexArray, PackedRadixTreeData } from './types'

/**
 * Node-indexed parent pointers enabling per-term reconstruction without ever
 * materializing a global path blob. Reconstruction climbs leaf → root in
 * O(depth) and touches only the terms actually requested, which is the whole
 * point of deferring string materialization.
 *
 * - `leafNodeByTermIndex[ti]` is the node carrying term `ti`'s leaf.
 * - `parentNode[node]` is `node`'s parent (root = node `0`, value unused).
 * - `parentEdge[node]` is the edge index linking `parentNode[node]` to `node`.
 *
 * All three are built by cheap linear scans (O(nodeCount + edgeCount)), with no
 * recursion and no per-term allocation, so building them is far cheaper than the
 * former whole-tree DFS + path-edge blob.
 */
export type PackedLazyTermMetadata = {
  leafNodeByTermIndex: PackedIndexArray
  parentNode: PackedIndexArray
  parentEdge: PackedIndexArray
}

export function buildLazyTermMetadata(tree: PackedRadixTreeData): PackedLazyTermMetadata {
  const termCount = tree.size
  const nodeCount = tree.nodeCount
  const edgeCount = tree.edgeCount

  if (termCount === 0 || nodeCount === 0) {
    return {
      leafNodeByTermIndex: new Uint8Array(0),
      parentNode: new Uint8Array(0),
      parentEdge: new Uint8Array(0),
    }
  }

  const leafNodeByTermIndex = packedIndexArray(termCount, nodeCount - 1)
  const parentNode = packedIndexArray(nodeCount, nodeCount - 1)
  const parentEdge = packedIndexArray(nodeCount, Math.max(edgeCount - 1, 0))

  let leafCount = 0
  for (let node = 0; node < nodeCount; node++) {
    if (decodeLeafSlot(tree.nodeLeafOrder[node]) >= 0) {
      leafNodeByTermIndex[tree.nodeValue[node]] = node
      leafCount++
    }
    const end = tree.nodeEdgeOffset[node + 1]
    for (let ei = tree.nodeEdgeOffset[node]; ei < end; ei++) {
      const child = tree.edgeChild[ei]
      parentNode[child] = node
      parentEdge[child] = ei
    }
  }

  if (leafCount !== termCount) {
    throw new Error(`PackedRadixTree: lazy metadata leaf count ${leafCount} !== term count ${termCount}`)
  }

  return { leafNodeByTermIndex, parentNode, parentEdge }
}

function assertTermIndex(tree: PackedRadixTreeData, termIndex: number): void {
  if (termIndex < 0 || termIndex >= tree.size) {
    throw new RangeError(`PackedRadixTree: term index out of range: ${termIndex}`)
  }
}

/** Reconstruct a single term by climbing parent edges from its leaf to the root. */
export function reconstructTermFromIndex(
  tree: PackedRadixTreeData,
  metadata: PackedLazyTermMetadata,
  termIndex: number,
): string {
  assertTermIndex(tree, termIndex)
  const heap = tree.labelHeap
  const { edgeLabelStart, edgeLabelLength } = tree

  let result = ''
  let node = metadata.leafNodeByTermIndex[termIndex]
  while (node !== 0) {
    const ei = metadata.parentEdge[node]
    result = labelSlice(heap, edgeLabelStart[ei], edgeLabelLength[ei]) + result
    node = metadata.parentNode[node]
  }
  return result
}

/** Term length (UTF-16 code units) without materializing the string. */
export function termLengthFromIndex(
  tree: PackedRadixTreeData,
  metadata: PackedLazyTermMetadata,
  termIndex: number,
): number {
  assertTermIndex(tree, termIndex)
  let length = 0
  let node = metadata.leafNodeByTermIndex[termIndex]
  while (node !== 0) {
    length += tree.edgeLabelLength[metadata.parentEdge[node]]
    node = metadata.parentNode[node]
  }
  return length
}
