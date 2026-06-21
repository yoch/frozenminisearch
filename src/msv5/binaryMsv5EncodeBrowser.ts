import type { RadixTree } from '../SearchableMap/types'
import type { FrozenSnapshot } from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import type { BrowserBinaryCompression } from '../searchTypes'
import { assembleMsv5FileBrowser } from './binaryMsv5CompressionBrowser'
import { prepareEncodeFrozenSnapshotMsv5 } from './binaryMsv5EncodeShared'

export function encodeFrozenSnapshotMsv5Browser(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
  compression?: BrowserBinaryCompression,
): Uint8Array {
  const { globalFlags, rawSections } = prepareEncodeFrozenSnapshotMsv5(snap, termTree, packedTermIndex)
  return assembleMsv5FileBrowser(globalFlags, rawSections, compression).buffer
}
