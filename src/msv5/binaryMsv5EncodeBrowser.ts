import type { FrozenSnapshot } from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import type { BrowserBinaryCompression } from '../searchTypes'
import { assembleMsv5FileBrowser } from './binaryMsv5CompressionBrowser'
import { buildMsv5EncodePrepared } from './binaryMsv5EncodeSections'
import { prepareEncodeFrozenSnapshotMsv5 } from './binaryMsv5EncodeShared'

/** @testonly */
export async function encodeFrozenSnapshotMsv5Browser(
  snap: FrozenSnapshot,
  compression?: BrowserBinaryCompression,
): Promise<Uint8Array> {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5(snap)
  const file = await assembleMsv5FileBrowser(
    globalFlags,
    rawSections,
    compression,
  )
  return file.buffer
}

/** Product encode path (browser); see `encodeFrozenSnapshotMsv5Packed` for Node. */
export async function encodeFrozenSnapshotMsv5PackedBrowser(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
  compression?: BrowserBinaryCompression,
): Promise<Uint8Array> {
  const { globalFlags, rawSections } = buildMsv5EncodePrepared(
    snap,
    packedTermIndex,
  )
  const file = await assembleMsv5FileBrowser(
    globalFlags,
    rawSections,
    compression,
  )
  return file.buffer
}
