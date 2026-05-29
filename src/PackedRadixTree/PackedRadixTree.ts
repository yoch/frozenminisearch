import { PACKED_NO_VALUE } from './constants'
import { packedRadixFuzzyEntries } from './fuzzy'
import { edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import { labelSlice } from './strings'
import type { PackedRadixTreeData, PackedStringRadixMap } from './types'

function labelsMatch(heap: string, start: number, len: number, key: string, keyOff: number): boolean {
  for (let i = 0; i < len; i++) {
    if (heap.charCodeAt(start + i) !== key.charCodeAt(keyOff + i)) return false
  }
  return true
}

export default class PackedRadixTree implements PackedStringRadixMap<number>, PackedRadixTreeData {
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

  static fromData(data: PackedRadixTreeData): PackedRadixTree {
    return new PackedRadixTree(data)
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
}
