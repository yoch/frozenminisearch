import { packedRadixFuzzyEntries } from './fuzzy'
import { decodeLeafSlot, edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import { labelSlice } from './strings'
import type { PackedIndexArray, PackedRadixTreeData, PackedStringRadixMap } from './types'

function labelsMatch(heap: string, start: number, len: number, key: string, keyOff: number): boolean {
  for (let i = 0; i < len; i++) {
    if (heap.charCodeAt(start + i) !== key.charCodeAt(keyOff + i)) return false
  }
  return true
}

type EmitFrame = {
  node: number
  slot: number
  first: number
  leafSlot: number
  prefix: string
}

function pushEmitFrame(frames: EmitFrame[], tree: PackedRadixTree, node: number, prefix: string): void {
  const first = tree.nodeEdgeOffset[node]
  const edgeCount = tree.nodeEdgeOffset[node + 1] - first
  const leafSlot = decodeLeafSlot(tree.nodeLeafOrder[node])
  const totalCount = packedNodeChildCount(edgeCount, leafSlot >= 0)
  frames.push({ node, slot: totalCount - 1, first, leafSlot, prefix })
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
    const walk = this.walkKey(term, false)
    if (walk == null || !walk.keyFullyConsumed) return undefined
    if (this.nodeLeafOrder[walk.node] === 0) return undefined
    return this.nodeValue[walk.node]
  }

  * entries(): IterableIterator<[string, number]> {
    yield *this.emitSubtree(0, '')
  }

  * prefixEntries(prefix: string): IterableIterator<[string, number]> {
    const start = this.resolvePrefixWalk(prefix)
    if (start == null) return
    yield *this.emitSubtree(start.node, start.prefix)
  }

  /**
   * Walk `prefix` to the subtree root; returns accumulated heap label prefix string.
   * `null` when no terms share the prefix.
   */
  private resolvePrefixWalk(prefix: string): { node: number, prefix: string } | null {
    if (prefix.length === 0) {
      return { node: 0, prefix: '' }
    }
    const walk = this.walkKey(prefix, true)
    if (walk == null) return null
    return { node: walk.node, prefix: walk.prefix }
  }

  /**
   * Follow `key` from the root. Shared by exact lookup and prefix iteration.
   * Mid-edge stop uses the full edge label in `prefix` (SearchableMap parity).
   */
  private walkKey(
    key: string,
    accumulatePrefix: boolean,
  ): { node: number, prefix: string, keyFullyConsumed: boolean } | null {
    let node = 0
    let prefixStr = ''
    let pos = 0
    const heap = this.labelHeap
    const n = key.length

    while (pos < n) {
      const ei = this.findEdge(node, key.charCodeAt(pos))
      if (ei < 0) return null

      const start = this.edgeLabelStart[ei]
      const len = this.edgeLabelLength[ei]
      const remaining = n - pos

      if (remaining < len) {
        if (!labelsMatch(heap, start, remaining, key, pos)) return null
        if (accumulatePrefix) prefixStr += labelSlice(heap, start, len)
        return { node: this.edgeChild[ei], prefix: prefixStr, keyFullyConsumed: false }
      }

      if (!labelsMatch(heap, start, len, key, pos)) return null
      if (accumulatePrefix) prefixStr += labelSlice(heap, start, len)
      pos += len
      node = this.edgeChild[ei]
    }

    return { node, prefix: prefixStr, keyFullyConsumed: true }
  }

  /**
   * Depth-first traversal matching {@link SearchableMap}'s `TreeIterator`, which
   * visits siblings in reverse Map-insertion order (last key first). The leaf, if
   * any, sits at `nodeLeafOrder` among the original sibling slots; everything else
   * is an edge. Exact order matters for prefix iteration and autoSuggest parity.
   */
  private * emitSubtree(startNode: number, startPrefix: string): IterableIterator<[string, number]> {
    const heap = this.labelHeap
    const frames: EmitFrame[] = []
    pushEmitFrame(frames, this, startNode, startPrefix)

    while (frames.length) {
      const frame = frames[frames.length - 1]
      if (frame.slot < 0) {
        frames.pop()
        continue
      }

      const slot = frame.slot--
      const edgeOffset = edgeOffsetAtSlot(slot, frame.leafSlot)
      if (edgeOffset < 0) {
        yield [frame.prefix, this.nodeValue[frame.node]]
        continue
      }

      const ei = frame.first + edgeOffset
      const start = this.edgeLabelStart[ei]
      const len = this.edgeLabelLength[ei]
      const childPrefix = frame.prefix + labelSlice(heap, start, len)
      pushEmitFrame(frames, this, this.edgeChild[ei], childPrefix)
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
