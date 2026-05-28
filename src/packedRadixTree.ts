import { LEAF } from './SearchableMap/TreeIterator'
import type { RadixTree } from './SearchableMap/types'
import type { FrozenTermIndex } from './frozenTermIndex'
import { MAX_PACKED_EDGE_LABEL_LENGTH, PACKED_NO_VALUE } from './packedRadixConstants'
import { edgeOffsetAtSlot, packedNodeChildCount } from './packedRadixLayout'
import { packedRadixFuzzyEntries } from './packedRadixFuzzy'

export { PACKED_NO_VALUE } from './packedRadixConstants'

export interface PackedRadixTreeData {
  readonly size: number
  readonly nodeCount: number
  readonly edgeCount: number
  readonly labelHeap: string
  readonly nodeFirstEdge: Uint32Array
  readonly nodeEdgeCount: Uint32Array
  readonly nodeValue: Uint32Array
  readonly nodeLeafOrder: Uint32Array
  readonly edgeLabelStart: Uint32Array
  readonly edgeLabelLength: Uint16Array
  readonly edgeChild: Uint32Array
  readonly edgeFirstChar: Uint16Array
}

function labelSlice(heap: string, start: number, len: number): string {
  return heap.slice(start, start + len)
}

function labelsMatch(heap: string, start: number, len: number, key: string, keyOff: number): boolean {
  for (let i = 0; i < len; i++) {
    if (heap.charCodeAt(start + i) !== key.charCodeAt(keyOff + i)) return false
  }
  return true
}

export function frozenTermIndexFromRadixTree(
  tree: RadixTree<number>,
  termCount?: number,
): PackedFrozenRadixTree {
  return PackedFrozenRadixTree.fromRadixTree(tree, termCount)
}

export default class PackedFrozenRadixTree implements FrozenTermIndex, PackedRadixTreeData {
  readonly size: number
  readonly nodeCount: number
  readonly edgeCount: number
  readonly labelHeap: string
  readonly nodeFirstEdge: Uint32Array
  readonly nodeEdgeCount: Uint32Array
  readonly nodeValue: Uint32Array
  readonly nodeLeafOrder: Uint32Array
  readonly edgeLabelStart: Uint32Array
  readonly edgeLabelLength: Uint16Array
  readonly edgeChild: Uint32Array
  readonly edgeFirstChar: Uint16Array

  private constructor(data: PackedRadixTreeData) {
    this.size = data.size
    this.nodeCount = data.nodeCount
    this.edgeCount = data.edgeCount
    this.labelHeap = data.labelHeap
    this.nodeFirstEdge = data.nodeFirstEdge
    this.nodeEdgeCount = data.nodeEdgeCount
    this.nodeValue = data.nodeValue
    this.nodeLeafOrder = data.nodeLeafOrder
    this.edgeLabelStart = data.edgeLabelStart
    this.edgeLabelLength = data.edgeLabelLength
    this.edgeChild = data.edgeChild
    this.edgeFirstChar = data.edgeFirstChar
  }

  static fromRadixTree(tree: RadixTree<number>, termCount?: number): PackedFrozenRadixTree {
    type EdgeScratch = { label: string, child: number }
    type NodeScratch = { value: number, leafOrder: number, edges: EdgeScratch[] }
    const nodes: NodeScratch[] = []
    let leafCount = 0

    function packNode(node: RadixTree<number>): number {
      const nodeId = nodes.length
      const scratch: NodeScratch = { value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] }
      nodes.push(scratch)
      let childOrder = 0

      for (const [key, val] of node) {
        if (key === LEAF) {
          scratch.value = val as number
          scratch.leafOrder = childOrder
          leafCount++
        } else {
          scratch.edges.push({ label: key, child: packNode(val as RadixTree<number>) })
        }
        childOrder++
      }

      return nodeId
    }

    packNode(tree)
    const size = termCount ?? leafCount

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
          throw new Error('PackedFrozenRadixTree: edge label too long')
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

    return new PackedFrozenRadixTree({
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

  static fromData(data: PackedRadixTreeData): PackedFrozenRadixTree {
    return new PackedFrozenRadixTree(data)
  }

  private findEdge(node: number, firstChar: number): number {
    const first = this.nodeFirstEdge[node]
    const count = this.nodeEdgeCount[node]
    for (let e = 0; e < count; e++) {
      const ei = first + e
      if (this.edgeFirstChar[ei] === firstChar) return ei
    }
    return -1
  }

  get(term: string): number | undefined {
    let node = 0
    let pos = 0
    const n = term.length
    const heap = this.labelHeap

    while (pos < n) {
      const ei = this.findEdge(node, term.charCodeAt(pos))
      if (ei < 0) return undefined
      const start = this.edgeLabelStart[ei]
      const len = this.edgeLabelLength[ei]
      if (pos + len > n) return undefined
      if (!labelsMatch(heap, start, len, term, pos)) return undefined
      pos += len
      node = this.edgeChild[ei]
    }

    const v = this.nodeValue[node]
    return v === PACKED_NO_VALUE ? undefined : v
  }

  * entries(): IterableIterator<[string, number]> {
    yield *this.emitSubtree(0, '')
  }

  * prefixEntries(prefix: string): IterableIterator<[string, number]> {
    if (prefix.length === 0) {
      yield *this.entries()
      return
    }

    let node = 0
    let base = ''
    let pos = 0
    const heap = this.labelHeap
    const n = prefix.length

    while (pos < n) {
      const ei = this.findEdge(node, prefix.charCodeAt(pos))
      if (ei < 0) return

      const start = this.edgeLabelStart[ei]
      const len = this.edgeLabelLength[ei]
      const remaining = n - pos

      if (remaining < len) {
        if (!labelsMatch(heap, start, remaining, prefix, pos)) return
        base += labelSlice(heap, start, len)
        node = this.edgeChild[ei]
        yield *this.emitSubtree(node, base)
        return
      }

      if (!labelsMatch(heap, start, len, prefix, pos)) return
      base += labelSlice(heap, start, len)
      pos += len
      node = this.edgeChild[ei]
    }

    yield *this.emitSubtree(node, base)
  }

  /**
   * Depth-first traversal matching {@link SearchableMap}'s `TreeIterator`, which
   * visits siblings in reverse Map-insertion order (last key first). The leaf, if
   * any, sits at `nodeLeafOrder` among the original sibling slots; everything else
   * is an edge. Exact order matters for prefix iteration and autoSuggest parity.
   */
  private * emitSubtree(node: number, basePrefix: string): IterableIterator<[string, number]> {
    const first = this.nodeFirstEdge[node]
    const edgeCount = this.nodeEdgeCount[node]
    const leafOrder = this.nodeLeafOrder[node]
    const totalCount = packedNodeChildCount(edgeCount, this.nodeValue[node])
    const heap = this.labelHeap

    for (let slot = totalCount - 1; slot >= 0; slot--) {
      const edgeOffset = edgeOffsetAtSlot(slot, leafOrder)
      if (edgeOffset < 0) {
        yield [basePrefix, this.nodeValue[node]]
        continue
      }
      const ei = first + edgeOffset
      const childPrefix = basePrefix + labelSlice(heap, this.edgeLabelStart[ei], this.edgeLabelLength[ei])
      yield *this.emitSubtree(this.edgeChild[ei], childPrefix)
    }
  }

  fuzzyEntries(term: string, maxDistance: number): Iterable<[string, number, number]> {
    return packedRadixFuzzyEntries(this, term, maxDistance)
  }

  packedByteLength(): number {
    return (
      this.nodeFirstEdge.byteLength
      + this.nodeEdgeCount.byteLength
      + this.nodeValue.byteLength
      + this.nodeLeafOrder.byteLength
      + this.edgeLabelStart.byteLength
      + this.edgeLabelLength.byteLength
      + this.edgeChild.byteLength
      + this.edgeFirstChar.byteLength
      + this.labelHeap.length * 2
    )
  }

  packedNodeCount(): number {
    return this.nodeCount
  }

  packedEdgeCount(): number {
    return this.edgeCount
  }

  validateLeaves(termCount: number): void {
    if (
      this.nodeFirstEdge.length !== this.nodeCount
      || this.nodeEdgeCount.length !== this.nodeCount
      || this.nodeValue.length !== this.nodeCount
      || this.nodeLeafOrder.length !== this.nodeCount
      || this.edgeLabelStart.length !== this.edgeCount
      || this.edgeLabelLength.length !== this.edgeCount
      || this.edgeChild.length !== this.edgeCount
      || this.edgeFirstChar.length !== this.edgeCount
    ) {
      throw new Error('PackedFrozenRadixTree: array length mismatch')
    }
    if (this.nodeCount === 0) {
      throw new Error('PackedFrozenRadixTree: missing root node')
    }

    let leafCount = 0
    for (let node = 0; node < this.nodeCount; node++) {
      const first = this.nodeFirstEdge[node]
      const count = this.nodeEdgeCount[node]
      if (first + count > this.edgeCount) {
        throw new Error(`PackedFrozenRadixTree: node ${node} edge range out of bounds`)
      }

      const v = this.nodeValue[node]
      const leafOrder = this.nodeLeafOrder[node]
      if (v === PACKED_NO_VALUE) {
        if (leafOrder !== PACKED_NO_VALUE) {
          throw new Error(`PackedFrozenRadixTree: node ${node} has leaf order without leaf`)
        }
        continue
      }
      if (leafOrder >= count + 1) {
        throw new Error(`PackedFrozenRadixTree: node ${node} leaf order out of bounds`)
      }
      leafCount++
      if (!Number.isInteger(v) || v < 0 || v >= termCount) {
        throw new Error(`PackedFrozenRadixTree: leaf index out of range: ${v}`)
      }
    }
    for (let edge = 0; edge < this.edgeCount; edge++) {
      const start = this.edgeLabelStart[edge]
      const len = this.edgeLabelLength[edge]
      if (len === 0 || len > MAX_PACKED_EDGE_LABEL_LENGTH || start + len > this.labelHeap.length) {
        throw new Error(`PackedFrozenRadixTree: edge ${edge} label range out of bounds`)
      }
      if (this.edgeFirstChar[edge] !== this.labelHeap.charCodeAt(start)) {
        throw new Error(`PackedFrozenRadixTree: edge ${edge} first char mismatch`)
      }
      if (this.edgeChild[edge] >= this.nodeCount) {
        throw new Error(`PackedFrozenRadixTree: edge ${edge} child out of bounds`)
      }
    }
    if (leafCount !== termCount) {
      throw new Error(`PackedFrozenRadixTree: leaf count ${leafCount} !== termCount ${termCount}`)
    }
    if (this.size !== termCount) {
      throw new Error(`PackedFrozenRadixTree: size ${this.size} !== termCount ${termCount}`)
    }
  }
}
