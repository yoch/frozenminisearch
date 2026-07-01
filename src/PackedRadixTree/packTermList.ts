import { MAX_PACKED_EDGE_LABEL_LENGTH, PACKED_NO_VALUE } from './constants'
import { packedIndexArray } from './layout'
import PackedRadixTree from './PackedRadixTree'

export type EdgeScratch = { label: string, child: number }
export type NodeScratch = { value: number, leafOrder: number, edges: EdgeScratch[] }

type SortedTermOrder = Uint32Array

type DirectGroup = {
  start: number
  end: number
  lcp: number
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

function compareTerms(terms: readonly string[], a: number, b: number): number {
  const left = terms[a]
  const right = terms[b]
  return left < right ? -1 : left > right ? 1 : a - b
}

function sortedTermOrder(terms: readonly string[]): SortedTermOrder {
  const order = new Uint32Array(terms.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  order.sort((a, b) => compareTerms(terms, a, b))
  return order
}

function commonPrefixLength(
  terms: readonly string[],
  order: SortedTermOrder,
  start: number,
  end: number,
  depth: number,
): number {
  const first = terms[order[start]]
  let lcp = first.length
  for (let i = start + 1; i < end; i++) {
    const term = terms[order[i]]
    const max = Math.min(lcp, term.length)
    let j = depth
    while (j < max && first.charCodeAt(j) === term.charCodeAt(j)) j++
    lcp = j
    if (lcp === depth) break
  }
  return lcp
}

function collectDirectGroups(
  terms: readonly string[],
  order: SortedTermOrder,
  start: number,
  end: number,
  depth: number,
): DirectGroup[] {
  const groups: DirectGroup[] = []
  let cursor = start
  while (cursor < end && terms[order[cursor]].length === depth) cursor++

  while (cursor < end) {
    const groupStart = cursor
    const firstChar = terms[order[cursor]].charCodeAt(depth)
    cursor++
    while (cursor < end && terms[order[cursor]].charCodeAt(depth) === firstChar) cursor++
    groups.push({
      start: groupStart,
      end: cursor,
      lcp: commonPrefixLength(terms, order, groupStart, cursor, depth),
    })
  }
  return groups
}

function buildScratchFromSorted(
  terms: readonly string[],
  order: SortedTermOrder,
): NodeScratch[] {
  const nodes: NodeScratch[] = []

  function writeNode(start: number, end: number, depth: number): number {
    const nodeId = nodes.length
    nodes.push({ value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] })
    const node = nodes[nodeId]!
    const hasLeaf = start < end && terms[order[start]]!.length === depth
    const groups = collectDirectGroups(terms, order, start, end, depth)

    if (hasLeaf) {
      node.value = order[start]!
      node.leafOrder = groups.length
    }

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!
      const label = terms[order[group.start]]!.slice(depth, group.lcp)
      if (label.length > MAX_PACKED_EDGE_LABEL_LENGTH) {
        throw new Error('PackedRadixTree: edge label too long')
      }
      node.edges.push({ label, child: writeNode(group.start, group.end, group.lcp) })
    }

    return nodeId
  }

  writeNode(0, terms.length, 0)
  return nodes
}

/** Pack a term list in snapshot order (`terms[i]` → leaf index `i`). */
export function packTermsFromList(terms: readonly string[]): PackedRadixTree {
  const order = sortedTermOrder(terms)
  return finalizePackedRadixScratch(buildScratchFromSorted(terms, order), terms.length)
}
