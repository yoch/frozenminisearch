import {
  encodeFrozenSnapshotMsv5Packed,
  encodeFrozenSnapshotMsv5PackedAsync,
} from './msv5/binaryMsv5EncodePacked'
import type { FrozenTermIndex } from './frozenTermIndex'
import type { FrozenSnapshot } from './binaryStructures'
import type { BinaryCompression } from './searchTypes'

/** Encode a frozen snapshot using an already-packed runtime term index (product path). */
export function encodeFrozenSnapshotPacked(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BinaryCompression,
): Buffer {
  return encodeFrozenSnapshotMsv5Packed(snap, packedTermIndex, compression)
}

/** Async product encoder; no legacy radix-tree fallback on the wire path. */
export function encodeFrozenSnapshotPackedAsync(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BinaryCompression,
): Promise<Buffer> {
  return encodeFrozenSnapshotMsv5PackedAsync(snap, packedTermIndex, compression)
}
