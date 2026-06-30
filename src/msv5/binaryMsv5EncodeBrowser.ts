import type { FrozenSnapshot } from '../binaryStructures'
import type { BrowserBinaryCompression } from '../searchTypes'
import { assembleMsv5FileBrowser } from './binaryMsv5CompressionBrowser'
import { prepareEncodeFrozenSnapshotMsv5 } from './binaryMsv5EncodeShared'

export async function encodeFrozenSnapshotMsv5Browser(
  snap: FrozenSnapshot,
  compression?: BrowserBinaryCompression,
): Promise<Uint8Array> {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5(snap)
  const file = await assembleMsv5FileBrowser(globalFlags, rawSections, compression)
  return file.buffer
}
