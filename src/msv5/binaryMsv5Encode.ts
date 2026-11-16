import type { FrozenSnapshot } from '../binaryStructures'
import type { BinaryCompression } from '../searchTypes'
import { assembleMsv5File } from './binaryMsv5Compression'
import { prepareEncodeFrozenSnapshotMsv5 } from './binaryMsv5EncodeShared'

export function encodeFrozenSnapshotMsv5(
  snap: FrozenSnapshot,
  compression?: BinaryCompression,
): Buffer {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5(snap)
  return assembleMsv5File(globalFlags, rawSections, compression).buffer
}
