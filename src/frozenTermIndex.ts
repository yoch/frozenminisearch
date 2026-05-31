import PackedRadixTree from './PackedRadixTree'
import { MAX_PACKED_EDGE_LABEL_LENGTH } from './PackedRadixTree/constants'
import { decodeLeafSlot } from './PackedRadixTree/layout'

/** Frozen term index used by {@link FrozenMiniSearch} (packed radix tree). */
export type FrozenTermIndex = PackedRadixTree

/** Validate packed-tree invariants for a frozen index (term indices in `[0, termCount)`). */
export function validateFrozenTermIndexLeaves(tree: PackedRadixTree, termCount: number): void {
  if (
    tree.nodeEdgeOffset.length !== tree.nodeCount + 1
    || tree.nodeValue.length !== tree.nodeCount
    || tree.nodeLeafOrder.length !== tree.nodeCount
    || tree.edgeLabelStart.length !== tree.edgeCount
    || tree.edgeLabelLength.length !== tree.edgeCount
    || tree.edgeChild.length !== tree.edgeCount
  ) {
    throw new Error('FrozenTermIndex: array length mismatch')
  }
  if (tree.nodeCount === 0) {
    throw new Error('FrozenTermIndex: missing root node')
  }
  if (tree.nodeEdgeOffset[0] !== 0 || tree.nodeEdgeOffset[tree.nodeCount] !== tree.edgeCount) {
    throw new Error('FrozenTermIndex: edge offsets not bounded by [0, edgeCount]')
  }

  const seenLeaves = new Uint8Array(termCount)
  let leafCount = 0
  for (let node = 0; node < tree.nodeCount; node++) {
    const first = tree.nodeEdgeOffset[node]
    const count = tree.nodeEdgeOffset[node + 1] - first
    if (count < 0) {
      throw new Error(`FrozenTermIndex: node ${node} edge offsets not monotonic`)
    }

    const leafSlot = decodeLeafSlot(tree.nodeLeafOrder[node])
    if (leafSlot < 0) {
      if (tree.nodeValue[node] !== 0) {
        throw new Error(`FrozenTermIndex: node ${node} has value without leaf`)
      }
      continue
    }
    if (leafSlot >= count + 1) {
      throw new Error(`FrozenTermIndex: node ${node} leaf order out of bounds`)
    }
    leafCount++
    const v = tree.nodeValue[node]
    if (!Number.isInteger(v) || v < 0 || v >= termCount) {
      throw new Error(`FrozenTermIndex: leaf index out of range: ${v}`)
    }
    if (seenLeaves[v] !== 0) {
      throw new Error(`FrozenTermIndex: duplicate leaf index: ${v}`)
    }
    seenLeaves[v] = 1
  }
  for (let edge = 0; edge < tree.edgeCount; edge++) {
    const start = tree.edgeLabelStart[edge]
    const len = tree.edgeLabelLength[edge]
    if (len === 0 || len > MAX_PACKED_EDGE_LABEL_LENGTH || start + len > tree.labelHeap.length) {
      throw new Error(`FrozenTermIndex: edge ${edge} label range out of bounds`)
    }
    if (tree.edgeChild[edge] >= tree.nodeCount) {
      throw new Error(`FrozenTermIndex: edge ${edge} child out of bounds`)
    }
  }
  if (leafCount !== termCount) {
    throw new Error(`FrozenTermIndex: leaf count ${leafCount} !== termCount ${termCount}`)
  }
  if (tree.size !== termCount) {
    throw new Error(`FrozenTermIndex: size ${tree.size} !== termCount ${termCount}`)
  }
}
