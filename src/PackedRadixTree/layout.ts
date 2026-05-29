import { PACKED_NO_VALUE } from './constants'

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
