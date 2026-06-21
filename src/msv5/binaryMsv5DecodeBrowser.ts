import {
  isMsv5Bytes,
  loadMsv5SectionsBrowser,
  readMsv5GlobalFlagsBrowser,
  readMsv5SectionDirectory,
} from './binaryMsv5CompressionBrowser'
import {
  decodeMsv5Sections,
  validateMsv5Container,
  type FrozenDecodeHints,
} from './binaryMsv5DecodeShared'
import type { FrozenSnapshot } from '../binaryStructures'

export { isMsv5Bytes as isMsv5Buffer } from './binaryMsv5CompressionBrowser'

export function decodeFrozenSnapshotMsv5Browser(buf: Uint8Array, hints?: FrozenDecodeHints): FrozenSnapshot {
  const { globalFlags, directory } = validateMsv5Container(buf, {
    isMsv5Buffer: isMsv5Bytes,
    readMsv5GlobalFlags: readMsv5GlobalFlagsBrowser,
    readMsv5SectionDirectory,
  })
  return decodeMsv5Sections(globalFlags, loadMsv5SectionsBrowser(buf, directory), hints)
}
