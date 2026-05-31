import { PACKED_NO_VALUE } from './constants'
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
 * Number of logical children for a node: radix edges plus optional leaf slot.
 */
export function packedNodeChildCount(edgeCount: number, nodeValue: number): number {
  return edgeCount + (nodeValue === PACKED_NO_VALUE ? 0 : 1)
}

/**
 * Map a logical child slot (including optional leaf) to the edge offset.
 *
 * Returns `-1` when `slot` points to the leaf.
 */
export function edgeOffsetAtSlot(slot: number, leafOrder: number): number {
  if (slot === leafOrder) return -1
  return slot - (leafOrder !== PACKED_NO_VALUE && leafOrder < slot ? 1 : 0)
}
