import PackedRadixTree from './PackedRadixTree'
import { MAX_PACKED_EDGE_LABEL_LENGTH, PACKED_NO_VALUE } from './PackedRadixTree/constants'

/** Frozen term index used by {@link FrozenMiniSearch} (packed radix tree). */
export type FrozenTermIndex = PackedRadixTree

/** Validate packed-tree invariants for a frozen index (term indices in `[0, termCount)`). */
export function validateFrozenTermIndexLeaves(tree: PackedRadixTree, termCount: number): void {
  if (
    tree.nodeFirstEdge.length !== tree.nodeCount
    || tree.nodeEdgeCount.length !== tree.nodeCount
    || tree.nodeValue.length !== tree.nodeCount
    || tree.nodeLeafOrder.length !== tree.nodeCount
    || tree.edgeLabelStart.length !== tree.edgeCount
    || tree.edgeLabelLength.length !== tree.edgeCount
    || tree.edgeChild.length !== tree.edgeCount
    || tree.edgeFirstChar.length !== tree.edgeCount
  ) {
    throw new Error('FrozenTermIndex: array length mismatch')
  }
  if (tree.nodeCount === 0) {
    throw new Error('FrozenTermIndex: missing root node')
  }

  let leafCount = 0
  for (let node = 0; node < tree.nodeCount; node++) {
    const first = tree.nodeFirstEdge[node]
    const count = tree.nodeEdgeCount[node]
    if (first + count > tree.edgeCount) {
      throw new Error(`FrozenTermIndex: node ${node} edge range out of bounds`)
    }

    const v = tree.nodeValue[node]
    const leafOrder = tree.nodeLeafOrder[node]
    if (v === PACKED_NO_VALUE) {
      if (leafOrder !== PACKED_NO_VALUE) {
        throw new Error(`FrozenTermIndex: node ${node} has leaf order without leaf`)
      }
      continue
    }
    if (leafOrder >= count + 1) {
      throw new Error(`FrozenTermIndex: node ${node} leaf order out of bounds`)
    }
    leafCount++
    if (!Number.isInteger(v) || v < 0 || v >= termCount) {
      throw new Error(`FrozenTermIndex: leaf index out of range: ${v}`)
    }
  }
  for (let edge = 0; edge < tree.edgeCount; edge++) {
    const start = tree.edgeLabelStart[edge]
    const len = tree.edgeLabelLength[edge]
    if (len === 0 || len > MAX_PACKED_EDGE_LABEL_LENGTH || start + len > tree.labelHeap.length) {
      throw new Error(`FrozenTermIndex: edge ${edge} label range out of bounds`)
    }
    if (tree.edgeFirstChar[edge] !== tree.labelHeap.charCodeAt(start)) {
      throw new Error(`FrozenTermIndex: edge ${edge} first char mismatch`)
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
