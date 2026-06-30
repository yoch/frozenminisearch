import { encodeFrozenSnapshotMsv5, encodeFrozenSnapshotMsv5Async } from './msv5/binaryMsv5Encode'
import type { FrozenSnapshot } from './binaryStructures'
import type { BinaryCompression } from './searchTypes'

/** Encode a frozen snapshot as a binary buffer. */
export function encodeFrozenSnapshot(
  snap: FrozenSnapshot,
  compression?: BinaryCompression,
): Buffer {
  return encodeFrozenSnapshotMsv5(snap, compression)
}

/** Async encoder; uses the selected payload compression without blocking the event loop. */
export function encodeFrozenSnapshotAsync(
  snap: FrozenSnapshot,
  compression?: BinaryCompression,
): Promise<Buffer> {
  return encodeFrozenSnapshotMsv5Async(snap, compression)
}
