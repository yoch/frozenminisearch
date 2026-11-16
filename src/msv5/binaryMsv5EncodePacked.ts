import type { FrozenSnapshot } from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import type { BinaryCompression } from '../searchTypes'
import {
  assembleMsv5File,
  assembleMsv5FileAsync,
} from './binaryMsv5Compression'
import { buildMsv5EncodePrepared } from './binaryMsv5EncodeSections'

/**
 * Product encode path (Node): the runtime already owns the packed term index, so the
 * snapshot input stays the lighter shape built by `buildBinarySnapshotInput`.
 */
export function encodeFrozenSnapshotMsv5Packed(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BinaryCompression,
): Buffer {
  const { globalFlags, rawSections } = buildMsv5EncodePrepared(
    snap,
    packedTermIndex,
  )
  return assembleMsv5File(globalFlags, rawSections, compression).buffer
}

export async function encodeFrozenSnapshotMsv5PackedAsync(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BinaryCompression,
): Promise<Buffer> {
  const { globalFlags, rawSections } = buildMsv5EncodePrepared(
    snap,
    packedTermIndex,
  )
  return (await assembleMsv5FileAsync(globalFlags, rawSections, compression))
    .buffer
}
