import { LEAF } from '../../SearchableMap/TreeIterator'
import type { RadixTree } from '../../SearchableMap/types'
import { MAX_PACKED_EDGE_LABEL_LENGTH, PACKED_NO_VALUE } from '../constants'
import PackedRadixTree from '../PackedRadixTree'

export type PackRadixLeavesOptions<Leaf> = {
  termCount: number
  mapLeaf: (leaf: Leaf) => number
  inferTermCountFromLeaves?: boolean
}

export function fromRadixTree(tree: RadixTree<number>, termCount?: number): PackedRadixTree
export function fromRadixTree<Leaf>(
  tree: RadixTree<Leaf>,
  options: PackRadixLeavesOptions<Leaf>,
): PackedRadixTree
export function fromRadixTree<Leaf>(
  tree: RadixTree<Leaf>,
  termCountOrOptions?: number | PackRadixLeavesOptions<Leaf>,
): PackedRadixTree {
  if (termCountOrOptions != null && typeof termCountOrOptions === 'object') {
    const { termCount, mapLeaf, inferTermCountFromLeaves = false } = termCountOrOptions
    return packRadixTreeFromRadix(tree, termCount, mapLeaf, inferTermCountFromLeaves)
  }
  const termCount = termCountOrOptions
  if (termCount == null) {
    return packRadixTreeFromRadix(tree, 0, leaf => leaf as unknown as number, true)
  }
  return packRadixTreeFromRadix(tree, termCount, leaf => leaf as unknown as number, false)
}

function packRadixTreeFromRadix<Leaf>(
  tree: RadixTree<Leaf>,
  termCount: number,
  mapLeaf: (leaf: Leaf) => number,
  inferTermCountFromLeaves: boolean,
): PackedRadixTree {
  type EdgeScratch = { label: string, child: number }
  type NodeScratch = { value: number, leafOrder: number, edges: EdgeScratch[] }
  const nodes: NodeScratch[] = []
  let leafCount = 0

  function packNode(node: RadixTree<Leaf>): number {
    const nodeId = nodes.length
    const scratch: NodeScratch = { value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] }
    nodes.push(scratch)
    let childOrder = 0

    for (const [key, val] of node) {
      if (key === LEAF) {
        scratch.value = mapLeaf(val as Leaf)
        scratch.leafOrder = childOrder
        leafCount++
      } else {
        scratch.edges.push({ label: key, child: packNode(val as RadixTree<Leaf>) })
      }
      childOrder++
    }

    return nodeId
  }

  packNode(tree)
  const size = inferTermCountFromLeaves ? leafCount : termCount

  const nodeCount = nodes.length
  const edgeCount = nodes.reduce((sum, n) => sum + n.edges.length, 0)
  const nodeFirstEdge = new Uint32Array(nodeCount)
  const nodeEdgeCount = new Uint32Array(nodeCount)
  const nodeValue = new Uint32Array(nodeCount)
  const nodeLeafOrder = new Uint32Array(nodeCount)
  const edgeLabelStart = new Uint32Array(edgeCount)
  const edgeLabelLength = new Uint16Array(edgeCount)
  const edgeChild = new Uint32Array(edgeCount)
  const edgeFirstChar = new Uint16Array(edgeCount)
  let labelHeap = ''
  let edgeIndex = 0

  for (let nodeId = 0; nodeId < nodeCount; nodeId++) {
    const node = nodes[nodeId]
    nodeValue[nodeId] = node.value
    nodeLeafOrder[nodeId] = node.leafOrder
    nodeFirstEdge[nodeId] = edgeIndex
    nodeEdgeCount[nodeId] = node.edges.length
    for (const edge of node.edges) {
      if (edge.label.length > MAX_PACKED_EDGE_LABEL_LENGTH) {
        throw new Error('PackedRadixTree: edge label too long')
      }
      const start = labelHeap.length
      labelHeap += edge.label
      edgeLabelStart[edgeIndex] = start
      edgeLabelLength[edgeIndex] = edge.label.length
      edgeFirstChar[edgeIndex] = edge.label.charCodeAt(0)
      edgeChild[edgeIndex] = edge.child
      edgeIndex++
    }
  }

  return PackedRadixTree.fromData({
    size,
    nodeCount,
    edgeCount,
    labelHeap,
    nodeFirstEdge,
    nodeEdgeCount,
    nodeValue,
    nodeLeafOrder,
    edgeLabelStart,
    edgeLabelLength,
    edgeChild,
    edgeFirstChar,
  })
}
