import { packedRadixFuzzyRefs, packedRadixVisitFuzzyRefs } from './fuzzy'
import type { PackedFuzzyRef, PackedTermRef } from './types'
import { decodeLeafSlot, edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import {
  buildLazyTermMetadata,
  reconstructTermFromIndex,
  termLengthFromIndex,
  type PackedLazyTermMetadata,
} from './lazyMetadata'
import { emitSubtree } from './stringEmit'
import type { PackedIndexArray, PackedRadixTreeData, PackedStringRadixMap } from './types'

function labelsMatch(heap: string, start: number, len: number, key: string, keyOff: number): boolean {
  for (let i = 0; i < len; i++) {
    if (heap.charCodeAt(start + i) !== key.charCodeAt(keyOff + i)) return false
  }
  return true
}

type EmitRefFrame = {
  node: number
  slot: number
  first: number
  leafSlot: number
  length: number
}

function pushEmitRefFrame(frames: EmitRefFrame[], tree: PackedRadixTree, node: number, length: number): void {
  const first = tree.nodeEdgeOffset[node]
  const edgeCount = tree.nodeEdgeOffset[node + 1] - first
  const leafSlot = decodeLeafSlot(tree.nodeLeafOrder[node])
  const totalCount = packedNodeChildCount(edgeCount, leafSlot >= 0)
  frames.push({ node, slot: totalCount - 1, first, leafSlot, length })
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
  private _lazyTermMetadata: PackedLazyTermMetadata | undefined

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
    const walk = this.walkKey(term)
    if (walk == null || !walk.keyFullyConsumed) return undefined
    if (this.nodeLeafOrder[walk.node] === 0) return undefined
    return this.nodeValue[walk.node]
  }

  * entries(): IterableIterator<[string, number]> {
    yield* emitSubtree(this, 0, '')
  }

  * prefixRefs(prefix: string): IterableIterator<PackedTermRef> {
    const start = this.resolvePrefixWalkRef(prefix)
    if (start == null) return
    yield* this.emitSubtreeRefs(start.node, start.prefixLength)
  }

  visitPrefixRefs(prefix: string, visit: (termIndex: number, length: number) => void): void {
    const start = this.resolvePrefixWalkRef(prefix)
    if (start == null) return
    this.visitSubtreeRefs(start.node, start.prefixLength, visit)
  }

  private resolvePrefixWalkRef(prefix: string): { node: number, prefixLength: number } | null {
    if (prefix.length === 0) {
      return { node: 0, prefixLength: 0 }
    }
    const walk = this.walkKey(prefix)
    if (walk == null) return null
    return { node: walk.node, prefixLength: walk.prefixLength }
  }

  /**
   * Follow `key` from the root. Shared by exact lookup and prefix iteration.
   * Mid-edge stop uses the full edge label in `prefix` (SearchableMap parity).
   */
  private walkKey(
    key: string,
  ): { node: number, prefixLength: number, keyFullyConsumed: boolean } | null {
    let node = 0
    let prefixLength = 0
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
        prefixLength += len
        return { node: this.edgeChild[ei], prefixLength, keyFullyConsumed: false }
      }

      if (!labelsMatch(heap, start, len, key, pos)) return null
      prefixLength += len
      pos += len
      node = this.edgeChild[ei]
    }

    return { node, prefixLength, keyFullyConsumed: true }
  }

  // Iterable API; keep frame walk in sync with visitSubtreeRefs (query hot path).
  private* emitSubtreeRefs(startNode: number, startLength: number): IterableIterator<PackedTermRef> {
    const frames: EmitRefFrame[] = []
    pushEmitRefFrame(frames, this, startNode, startLength)

    while (frames.length) {
      const frame = frames[frames.length - 1]
      if (frame.slot < 0) {
        frames.pop()
        continue
      }

      const slot = frame.slot--
      const edgeOffset = edgeOffsetAtSlot(slot, frame.leafSlot)
      if (edgeOffset < 0) {
        yield { termIndex: this.nodeValue[frame.node], length: frame.length }
        continue
      }

      const ei = frame.first + edgeOffset
      const len = this.edgeLabelLength[ei]
      pushEmitRefFrame(frames, this, this.edgeChild[ei], frame.length + len)
    }
  }

  // Zero-allocation visitor; keep frame walk in sync with emitSubtreeRefs.
  private visitSubtreeRefs(
    startNode: number,
    startLength: number,
    visit: (termIndex: number, length: number) => void,
  ): void {
    const frames: EmitRefFrame[] = []
    pushEmitRefFrame(frames, this, startNode, startLength)

    while (frames.length) {
      const frame = frames[frames.length - 1]
      if (frame.slot < 0) {
        frames.pop()
        continue
      }

      const slot = frame.slot--
      const edgeOffset = edgeOffsetAtSlot(slot, frame.leafSlot)
      if (edgeOffset < 0) {
        visit(this.nodeValue[frame.node], frame.length)
        continue
      }

      const ei = frame.first + edgeOffset
      const len = this.edgeLabelLength[ei]
      pushEmitRefFrame(frames, this, this.edgeChild[ei], frame.length + len)
    }
  }

  fuzzyRefs(term: string, maxDistance: number): Iterable<PackedFuzzyRef> {
    return packedRadixFuzzyRefs(this, term, maxDistance)
  }

  visitFuzzyRefs(
    term: string,
    maxDistance: number,
    visit: (termIndex: number, length: number, distance: number) => void,
  ): void {
    packedRadixVisitFuzzyRefs(this, term, maxDistance, visit)
  }

  lazyTermMetadata(): PackedLazyTermMetadata {
    if (this._lazyTermMetadata == null) {
      this._lazyTermMetadata = buildLazyTermMetadata(this)
    }
    return this._lazyTermMetadata
  }

  termLengthByIndex(termIndex: number): number {
    return termLengthFromIndex(this, this.lazyTermMetadata(), termIndex)
  }

  termByIndex(termIndex: number): string {
    return reconstructTermFromIndex(this, this.lazyTermMetadata(), termIndex)
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
