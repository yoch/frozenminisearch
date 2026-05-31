import { packedRadixFuzzyEntries } from './fuzzy'
import { decodeLeafSlot, edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import { buildTermFromSegments, type LabelSegment } from './strings'
import type { PackedIndexArray, PackedRadixTreeData, PackedStringRadixMap } from './types'

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
  readonly nodeEdgeOffset: PackedIndexArray
  readonly nodeValue: PackedIndexArray
  readonly nodeLeafOrder: PackedIndexArray
  readonly edgeLabelStart: PackedIndexArray
  readonly edgeLabelLength: PackedIndexArray
  readonly edgeChild: PackedIndexArray

  private constructor(data: PackedRadixTreeData) {
    this.size = data.size
    this.nodeCount = data.nodeCount
    this.edgeCount = data.edgeCount
    this.labelHeap = data.labelHeap
    this.nodeEdgeOffset = data.nodeEdgeOffset
    this.nodeValue = data.nodeValue
    this.nodeLeafOrder = data.nodeLeafOrder
    this.edgeLabelStart = data.edgeLabelStart
    this.edgeLabelLength = data.edgeLabelLength
    this.edgeChild = data.edgeChild
  }

  static fromData(data: PackedRadixTreeData): PackedRadixTree {
    return new PackedRadixTree(data)
  }

  private findEdge(node: number, firstChar: number): number {
    const end = this.nodeEdgeOffset[node + 1]
    const heap = this.labelHeap
    for (let ei = this.nodeEdgeOffset[node]; ei < end; ei++) {
      if (heap.charCodeAt(this.edgeLabelStart[ei]) === firstChar) return ei
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

    if (this.nodeLeafOrder[node] === 0) return undefined
    return this.nodeValue[node]
  }

  * entries(): IterableIterator<[string, number]> {
    yield *this.emitSubtree(0, [])
  }

  * prefixEntries(prefix: string): IterableIterator<[string, number]> {
    if (prefix.length === 0) {
      yield *this.entries()
      return
    }

    let node = 0
    const segments: LabelSegment[] = []
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
        segments.push({ start, len })
        node = this.edgeChild[ei]
        yield *this.emitSubtree(node, segments)
        return
      }

      if (!labelsMatch(heap, start, len, prefix, pos)) return
      segments.push({ start, len })
      pos += len
      node = this.edgeChild[ei]
    }

    yield *this.emitSubtree(node, segments)
  }

  /**
   * Depth-first traversal matching {@link SearchableMap}'s `TreeIterator`, which
   * visits siblings in reverse Map-insertion order (last key first). The leaf, if
   * any, sits at `nodeLeafOrder` among the original sibling slots; everything else
   * is an edge. Exact order matters for prefix iteration and autoSuggest parity.
   */
  private * emitSubtree(node: number, segments: LabelSegment[]): IterableIterator<[string, number]> {
    const first = this.nodeEdgeOffset[node]
    const edgeCount = this.nodeEdgeOffset[node + 1] - first
    const leafSlot = decodeLeafSlot(this.nodeLeafOrder[node])
    const totalCount = packedNodeChildCount(edgeCount, leafSlot >= 0)
    const heap = this.labelHeap

    for (let slot = totalCount - 1; slot >= 0; slot--) {
      const edgeOffset = edgeOffsetAtSlot(slot, leafSlot)
      if (edgeOffset < 0) {
        yield [buildTermFromSegments(heap, segments), this.nodeValue[node]]
        continue
      }
      const ei = first + edgeOffset
      segments.push({
        start: this.edgeLabelStart[ei],
        len: this.edgeLabelLength[ei],
      })
      yield *this.emitSubtree(this.edgeChild[ei], segments)
      segments.pop()
    }
  }

  fuzzyEntries(term: string, maxDistance: number): Iterable<[string, number, number]> {
    return packedRadixFuzzyEntries(this, term, maxDistance)
  }

  packedByteLength(): number {
    return (
      this.nodeEdgeOffset.byteLength
      + this.nodeValue.byteLength
      + this.nodeLeafOrder.byteLength
      + this.edgeLabelStart.byteLength
      + this.edgeLabelLength.byteLength
      + this.edgeChild.byteLength
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
