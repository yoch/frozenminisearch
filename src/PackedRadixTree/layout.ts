import type { PackedIndexArray } from './types'

/**
 * Allocate the narrowest unsigned typed array that can hold every value in
 * `[0, maxValue]`. Mirrors the adaptive width choice already used for frozen
 * postings (Uint16 vs Uint32), trading nothing at read time for a smaller
 * footprint on the common small/medium index.
 */
export function packedIndexArray(length: number, maxValue: number): PackedIndexArray {
  if (maxValue <= 0xff) return new Uint8Array(length)
  if (maxValue <= 0xffff) return new Uint16Array(length)
  return new Uint32Array(length)
}

/**
 * Decode a stored `nodeLeafOrder` cell into a sibling slot: `-1` when the node
 * has no leaf, otherwise the leaf's slot among its siblings. The stored value
 * is `slot + 1` (0 = no leaf), so plain subtraction recovers both cases.
 */
export function decodeLeafSlot(storedLeafOrder: number): number {
  return storedLeafOrder - 1
}

/**
 * Number of logical children for a node: radix edges plus optional leaf slot.
 */
export function packedNodeChildCount(edgeCount: number, hasLeaf: boolean): number {
  return edgeCount + (hasLeaf ? 1 : 0)
}

/**
 * Map a logical child slot (including optional leaf) to the edge offset.
 * `leafSlot` is the decoded slot (`-1` when the node has no leaf).
 *
 * Returns `-1` when `slot` points to the leaf.
 */
export function edgeOffsetAtSlot(slot: number, leafSlot: number): number {
  if (slot === leafSlot) return -1
  return slot - (leafSlot >= 0 && leafSlot < slot ? 1 : 0)
}
