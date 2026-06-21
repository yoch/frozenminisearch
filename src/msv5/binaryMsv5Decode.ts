import {
  isMsv5Buffer,
  loadMsv5Sections,
  loadMsv5SectionsAsync,
  readMsv5GlobalFlags,
  readMsv5SectionDirectory,
} from './binaryMsv5Compression'
import {
  decodeMsv5Sections,
  validateMsv5Container,
  type FrozenDecodeHints,
} from './binaryMsv5DecodeShared'
import type { FrozenSnapshot } from '../binaryStructures'

export { isMsv5Buffer } from './binaryMsv5Compression'
export type { FrozenDecodeHints } from './binaryMsv5DecodeShared'

export function decodeFrozenSnapshotMsv5(buf: Buffer, hints?: FrozenDecodeHints): FrozenSnapshot {
  const { globalFlags, directory } = validateMsv5Container(buf, {
    isMsv5Buffer,
    readMsv5GlobalFlags,
    readMsv5SectionDirectory,
  })
  return decodeMsv5Sections(globalFlags, loadMsv5Sections(buf, directory), hints)
}

export async function decodeFrozenSnapshotMsv5Async(
  buf: Buffer,
  hints?: FrozenDecodeHints,
): Promise<FrozenSnapshot> {
  const { globalFlags, directory } = validateMsv5Container(buf, {
    isMsv5Buffer,
    readMsv5GlobalFlags,
    readMsv5SectionDirectory,
  })
  return decodeMsv5Sections(globalFlags, await loadMsv5SectionsAsync(buf, directory), hints)
}
