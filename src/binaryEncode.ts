import { encodeFrozenSnapshotMsv5, encodeFrozenSnapshotMsv5Async } from './msv5/binaryMsv5Encode'
import type { FrozenTermIndex } from './frozenTermIndex'
import type { FrozenSnapshot } from './binaryStructures'
import type { RadixTree } from './radixTree'
import type { BinaryCompression } from './searchTypes'

/** Encode a frozen snapshot as a binary buffer. */
export function encodeFrozenSnapshot(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
  compression?: BinaryCompression,
): Buffer {
  return encodeFrozenSnapshotMsv5(snap, termTree, packedTermIndex, compression)
}

/** Async encoder; uses the selected payload compression without blocking the event loop. */
export function encodeFrozenSnapshotAsync(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
  compression?: BinaryCompression,
): Promise<Buffer> {
  return encodeFrozenSnapshotMsv5Async(snap, termTree, packedTermIndex, compression)
}
