import { loadMsv5SectionsBrowser } from './binaryMsv5CompressionBrowser'
import {
  decodeMsv5Sections,
  validateMsv5Container,
  type FrozenDecodeHints,
} from './binaryMsv5DecodeShared'
import type { FrozenSnapshot } from '../binaryStructures'

export async function decodeFrozenSnapshotMsv5Browser(
  buf: Uint8Array,
  hints?: FrozenDecodeHints,
): Promise<FrozenSnapshot> {
  const { globalFlags, directory } = validateMsv5Container(buf)
  return decodeMsv5Sections(
    globalFlags,
    await loadMsv5SectionsBrowser(buf, directory),
    hints,
  )
}
