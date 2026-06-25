import type { FrozenSnapshot } from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import type { RadixTree } from '../radixTree'
import type { BinaryCompression } from '../searchTypes'
import { assembleMsv5File, assembleMsv5FileAsync } from './binaryMsv5Compression'
import { prepareEncodeFrozenSnapshotMsv5 } from './binaryMsv5EncodeShared'

export function encodeFrozenSnapshotMsv5(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
  compression?: BinaryCompression,
): Buffer {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5(snap, termTree, packedTermIndex)
  return assembleMsv5File(globalFlags, rawSections, compression).buffer
}

export async function encodeFrozenSnapshotMsv5Async(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
  compression?: BinaryCompression,
): Promise<Buffer> {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5(snap, termTree, packedTermIndex)
  return (await assembleMsv5FileAsync(globalFlags, rawSections, compression)).buffer
}
