import type { FrozenSnapshot } from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import type { BinaryCompression, BrowserBinaryCompression } from '../searchTypes'
import { assembleMsv5File, assembleMsv5FileAsync } from './binaryMsv5Compression'
import { assembleMsv5FileBrowser } from './binaryMsv5CompressionBrowser'
import { prepareMsv5Encode } from './binaryMsv5EncodeShared'

/**
 * Product encode path: the runtime already owns the packed term index, so the
 * snapshot input can stay as the lighter binary-facing shape built by
 * `buildBinarySnapshotInput`.
 */
export function prepareEncodeFrozenSnapshotMsv5Packed(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
) {
  return prepareMsv5Encode(snap, packedTermIndex)
}

export function encodeFrozenSnapshotMsv5Packed(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BinaryCompression,
): Buffer {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5Packed(snap, packedTermIndex)
  return assembleMsv5File(globalFlags, rawSections, compression).buffer
}

export async function encodeFrozenSnapshotMsv5PackedAsync(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BinaryCompression,
): Promise<Buffer> {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5Packed(snap, packedTermIndex)
  return (await assembleMsv5FileAsync(globalFlags, rawSections, compression)).buffer
}

export async function encodeFrozenSnapshotMsv5PackedBrowser(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BrowserBinaryCompression,
): Promise<Uint8Array> {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5Packed(snap, packedTermIndex)
  const file = await assembleMsv5FileBrowser(globalFlags, rawSections, compression)
  return file.buffer
}
