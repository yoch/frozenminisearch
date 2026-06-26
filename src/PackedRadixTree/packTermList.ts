import { MAX_PACKED_EDGE_LABEL_LENGTH, PACKED_NO_VALUE } from './constants'
import { packedIndexArray } from './layout'
import PackedRadixTree from './PackedRadixTree'

export type EdgeScratch = { label: string, child: number }
export type NodeScratch = { value: number, leafOrder: number, edges: EdgeScratch[] }
export type PackedRadixScratch = { nodes: NodeScratch[], rootId: number }

export function createPackedRadixScratch(): PackedRadixScratch {
  const nodes: NodeScratch[] = [{ value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] }]
  return { nodes, rootId: 0 }
}

/**
 * Insert one term with its leaf index into a mutable scratch radix trie.
 * Mirrors {@link setRadixLeaf} / {@link createRadixPath} without nested `Map` nodes.
 */
export function insertPackedRadixTerm(
  scratch: PackedRadixScratch,
  term: string,
  termIndex: number,
): void {
  const { nodes } = scratch
  let nodeId = scratch.rootId
  let pos = 0
  const keyLength = term.length

  while (pos < keyLength) {
    const node = nodes[nodeId]
    let matched = false

    for (let ei = 0; ei < node.edges.length; ei++) {
      const edge = node.edges[ei]
      const label = edge.label
      if (term[pos] !== label[0]) continue

      const len = Math.min(keyLength - pos, label.length)
      let offset = 1
      while (offset < len && term[pos + offset] === label[offset]) offset++

      if (offset === label.length) {
        nodeId = edge.child
        pos += offset
        matched = true
        break
      }

      const childId = edge.child
      const intermediateId = nodes.length
      nodes.push({ value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] })
      nodes[intermediateId].edges.push({ label: label.slice(offset), child: childId })
      // createRadixPath appends the replacement edge at the parent; prefix
      // iteration depends on this insertion order.
      node.edges.splice(ei, 1)
      node.edges.push({ label: term.slice(pos, pos + offset), child: intermediateId })
      nodeId = intermediateId
      pos += offset
      matched = true
      break
    }

    if (matched) continue

    const childId = nodes.length
    nodes.push({ value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] })
    node.edges.push({ label: term.slice(pos), child: childId })
    nodeId = childId
    pos = keyLength
  }

  const leafNode = nodes[nodeId]
  leafNode.value = termIndex
  leafNode.leafOrder = leafNode.edges.length
}

/** Finalize scratch nodes into a columnar {@link PackedRadixTree}. */
export function finalizePackedRadixScratch(
  nodes: NodeScratch[],
  termCount: number,
): PackedRadixTree {
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

/** Pack a term list in snapshot order (`terms[i]` → leaf index `i`). */
export function packTermsFromList(terms: readonly string[]): PackedRadixTree {
  const scratch = createPackedRadixScratch()
  for (let i = 0; i < terms.length; i++) {
    insertPackedRadixTerm(scratch, terms[i], i)
  }
  return finalizePackedRadixScratch(scratch.nodes, terms.length)
}
