import { LEAF, validateRadixLeaves, type RadixTree } from '../radixTree'
import { MAX_PACKED_EDGE_LABEL_LENGTH, PACKED_NO_VALUE } from './constants'
import { packedIndexArray } from './layout'
import PackedRadixTree from './PackedRadixTree'

export function fromRadixTree(tree: RadixTree<number>, termCount: number): PackedRadixTree {
  validateRadixLeaves(tree, termCount, (detail) => {
    throw new Error(`PackedRadixTree: ${detail}`)
  })
  return packRadixTree(tree, termCount)
}

function packRadixTree(
  tree: RadixTree<number>,
  termCount: number,
): PackedRadixTree {
  type EdgeScratch = { label: string, child: number }
  type NodeScratch = { value: number, leafOrder: number, edges: EdgeScratch[] }
  const nodes: NodeScratch[] = []

  function packNode(node: RadixTree<number>): number {
    const nodeId = nodes.length
    const scratch: NodeScratch = { value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] }
    nodes.push(scratch)
    let childOrder = 0

    for (const [key, val] of node) {
      if (key === LEAF) {
        scratch.value = val as number
        scratch.leafOrder = childOrder
      } else {
        scratch.edges.push({ label: key, child: packNode(val as RadixTree<number>) })
      }
      childOrder++
    }

    return nodeId
  }

  packNode(tree)

  const nodeCount = nodes.length
  let edgeCount = 0
  let totalLabelLength = 0
  let maxLabelLength = 0
  let maxNodeValue = 0
  let maxLeafOrderEncoded = 0
  for (const node of nodes) {
    edgeCount += node.edges.length
    for (const edge of node.edges) {
      totalLabelLength += edge.label.length
      if (edge.label.length > maxLabelLength) maxLabelLength = edge.label.length
    }
    if (node.value !== PACKED_NO_VALUE) {
      if (node.value > maxNodeValue) maxNodeValue = node.value
      if (node.leafOrder + 1 > maxLeafOrderEncoded) maxLeafOrderEncoded = node.leafOrder + 1
    }
  }

  const nodeEdgeOffset = packedIndexArray(nodeCount + 1, edgeCount)
  const nodeValue = packedIndexArray(nodeCount, maxNodeValue)
  const nodeLeafOrder = packedIndexArray(nodeCount, maxLeafOrderEncoded)
  const edgeLabelStart = packedIndexArray(edgeCount, totalLabelLength)
  const edgeLabelLength = packedIndexArray(edgeCount, maxLabelLength)
  const edgeChild = packedIndexArray(edgeCount, Math.max(nodeCount - 1, 0))
  const labelParts: string[] = []
  let labelHeapLength = 0
  let edgeIndex = 0

  for (let nodeId = 0; nodeId < nodeCount; nodeId++) {
    const node = nodes[nodeId]
    if (node.value !== PACKED_NO_VALUE) {
      nodeValue[nodeId] = node.value
      nodeLeafOrder[nodeId] = node.leafOrder + 1
    }
    nodeEdgeOffset[nodeId] = edgeIndex
    for (const edge of node.edges) {
      if (edge.label.length > MAX_PACKED_EDGE_LABEL_LENGTH) {
        throw new Error('PackedRadixTree: edge label too long')
      }
      const start = labelHeapLength
      labelParts.push(edge.label)
      labelHeapLength += edge.label.length
      edgeLabelStart[edgeIndex] = start
      edgeLabelLength[edgeIndex] = edge.label.length
      edgeChild[edgeIndex] = edge.child
      edgeIndex++
    }
  }
  nodeEdgeOffset[nodeCount] = edgeIndex
  const labelHeap = labelParts.join('')

  return PackedRadixTree.fromData({
    size: termCount,
    nodeCount,
    edgeCount,
    labelHeap,
    nodeEdgeOffset,
    nodeValue,
    nodeLeafOrder,
    edgeLabelStart,
    edgeLabelLength,
    edgeChild,
  })
}
