import type { RadixTree } from './SearchableMap/types'
import { encodeFrozenSnapshotMsv5, encodeFrozenSnapshotMsv5Async } from './msv5/binaryMsv5Encode'
import type { FrozenTermIndex } from './frozenTermIndex'
import type { FrozenSnapshot } from './binaryStructures'

/** Encode a frozen snapshot as **MSv5** (the only supported write format). */
export function encodeFrozenSnapshot(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): Buffer {
  return encodeFrozenSnapshotMsv5(snap, termTree, packedTermIndex)
}

/** Async MSv5 encoder; uses non-blocking zstd compression for large payloads. */
export function encodeFrozenSnapshotAsync(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): Promise<Buffer> {
  return encodeFrozenSnapshotMsv5Async(snap, termTree, packedTermIndex)
}
