import {
  TREE_NODE_EDGE,
  TREE_NODE_LEAF,
} from './binaryConstants'
import { invalidFrozenIndex } from './binaryIo'
import PackedRadixTree from './PackedRadixTree'
import { MAX_PACKED_EDGE_LABEL_LENGTH, PACKED_NO_VALUE } from './PackedRadixTree/constants'
import { edgeOffsetAtSlot, packedNodeChildCount } from './PackedRadixTree/layout'
import type { PackedRadixTreeData } from './PackedRadixTree'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'

function writePackedNode(chunks: Buffer[], tree: PackedRadixTree, node: number): void {
  const edgeCount = tree.nodeEdgeCount[node]
  const leafOrder = tree.nodeLeafOrder[node]
  const childCount = packedNodeChildCount(edgeCount, tree.nodeValue[node])
  if (childCount > 0xffff) {
    throw invalidFrozenIndex('term tree node has too many children')
  }

  const countBuf = Buffer.alloc(2)
  countBuf.writeUInt16LE(childCount, 0)
  chunks.push(countBuf)

  const first = tree.nodeFirstEdge[node]
  const heap = tree.labelHeap
  for (let slot = 0; slot < childCount; slot++) {
    const edgeOffset = edgeOffsetAtSlot(slot, leafOrder)
    if (edgeOffset < 0) {
      const leafBuf = Buffer.alloc(1 + 4)
      leafBuf.writeUInt8(TREE_NODE_LEAF, 0)
      leafBuf.writeUInt32LE(tree.nodeValue[node], 1)
      chunks.push(leafBuf)
      continue
    }

    const ei = first + edgeOffset
    const start = tree.edgeLabelStart[ei]
    const len = tree.edgeLabelLength[ei]
    const key = heap.slice(start, start + len)
    const keyBuf = Buffer.from(key, 'utf8')
    if (keyBuf.length > 0xffff) {
      throw invalidFrozenIndex('term tree edge key too long')
    }
    const header = Buffer.alloc(1 + 2 + keyBuf.length)
    header.writeUInt8(TREE_NODE_EDGE, 0)
    header.writeUInt16LE(keyBuf.length, 1)
    keyBuf.copy(header, 3)
    chunks.push(header)
    writePackedNode(chunks, tree, tree.edgeChild[ei])
  }
}

export function buildTermTreeSectionFromPacked(tree: PackedRadixTree): Buffer {
  const chunks: Buffer[] = []
  writePackedNode(chunks, tree, 0)
  return Buffer.concat(chunks)
}

interface DecodeNodeScratch {
  value: number
  leafOrder: number
  edges: Array<{ label: string, child: number }>
}

function readPackedNode(
  buf: Buffer,
  offset: number,
  end: number,
  nodes: DecodeNodeScratch[],
): { nodeId: number, next: number } {
  if (offset + 2 > end) {
    throw invalidFrozenIndex('term tree node child count truncated')
  }
  const childCount = buf.readUInt16LE(offset)
  let o = offset + 2

  const nodeId = nodes.length
  const scratch: DecodeNodeScratch = { value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] }
  nodes.push(scratch)

  for (let c = 0; c < childCount; c++) {
    if (o >= end) {
      throw invalidFrozenIndex('term tree child truncated')
    }
    const tag = buf.readUInt8(o)
    if (tag === TREE_NODE_LEAF) {
      if (o + 5 > end) {
        throw invalidFrozenIndex('term tree leaf truncated')
      }
      if (scratch.value !== PACKED_NO_VALUE) {
        throw invalidFrozenIndex('term tree node has duplicate leaf')
      }
      scratch.value = buf.readUInt32LE(o + 1)
      scratch.leafOrder = c
      o += 5
      continue
    }
    if (tag === TREE_NODE_EDGE) {
      if (o + 3 > end) {
        throw invalidFrozenIndex('term tree edge header truncated')
      }
      const keyLen = buf.readUInt16LE(o + 1)
      if (keyLen === 0) {
        throw invalidFrozenIndex('term tree edge key empty')
      }
      const keyStart = o + 3
      const keyEnd = keyStart + keyLen
      if (keyEnd > end) {
        throw invalidFrozenIndex('term tree edge key out of bounds')
      }
      const key = buf.toString('utf8', keyStart, keyEnd)
      const child = readPackedNode(buf, keyEnd, end, nodes)
      scratch.edges.push({ label: key, child: child.nodeId })
      o = child.next
      continue
    }
    throw invalidFrozenIndex(`unknown term tree node tag ${tag}`)
  }

  return { nodeId, next: o }
}

function flattenDecodedNodes(nodes: DecodeNodeScratch[], termCount: number): PackedRadixTreeData {
  const nodeCount = nodes.length
  const edgeCount = nodes.reduce((sum, n) => sum + n.edges.length, 0)
  const nodeFirstEdge = new Uint32Array(nodeCount)
  const nodeEdgeCount = new Uint32Array(nodeCount)
  const nodeValue = new Uint32Array(nodeCount)
  const nodeLeafOrder = new Uint32Array(nodeCount)
  const edgeLabelStart = new Uint32Array(edgeCount)
  const edgeLabelLength = new Uint16Array(edgeCount)
  const edgeChild = new Uint32Array(edgeCount)
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
        throw invalidFrozenIndex('term tree edge key too long')
      }
      const start = labelHeap.length
      labelHeap += edge.label
      edgeLabelStart[edgeIndex] = start
      edgeLabelLength[edgeIndex] = edge.label.length
      edgeChild[edgeIndex] = edge.child
      edgeIndex++
    }
  }

  return {
    size: termCount,
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
  }
}

export function readPackedTermTreeSection(
  buf: Buffer,
  offset: number,
  end: number,
  termCount: number,
): PackedRadixTree {
  const nodes: DecodeNodeScratch[] = []
  const { next } = readPackedNode(buf, offset, end, nodes)
  if (next !== end) {
    throw invalidFrozenIndex('term tree section has trailing bytes')
  }

  const tree = PackedRadixTree.fromData(flattenDecodedNodes(nodes, termCount))
  validateFrozenTermIndexLeaves(tree, termCount)
  return tree
}
