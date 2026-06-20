import {
  invalidFrozenIndex,
  readFloat32Array,
} from '../binaryIo'
import { MSV5_HEADER_SIZE } from './binaryMsv5Constants'
import {
  readExternalIdsSection,
  readFieldNamesSection,
  readStoredFieldsSection,
  validateFrozenSnapshot,
  type FrozenSnapshot,
} from '../binaryStructures'
import { readStoredFieldsWireSection } from '../storedFieldsWire'
import { readFieldLengthMatrixSection } from '../fieldLengthMatrix'
import {
  isMsv5Buffer,
  loadMsv5Sections,
  loadMsv5SectionsAsync,
  readMsv5GlobalFlags,
  readMsv5SectionDirectory,
} from './binaryMsv5Compression'
import {
  MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_OFFSET,
} from './binaryMsv5Constants'
import { Msv5SectionId } from './binaryMsv5Constants'
import { decodeMsv5PostingsSections } from './binaryMsv5Postings'
import { readPackedTermTreeSectionColumnar } from './packedRadixBinaryMsv5'

export { isMsv5Buffer } from './binaryMsv5Compression'

export type FrozenDecodeHints = {
  storeFields: readonly string[]
}

function validateMsv5Container(buf: Buffer): {
  globalFlags: number
  directory: ReturnType<typeof readMsv5SectionDirectory>
} {
  if (!isMsv5Buffer(buf)) {
    throw invalidFrozenIndex('not a frozen binary snapshot')
  }
  const version = buf.readUInt16LE(4)
  if (version !== 5) {
    throw invalidFrozenIndex(`unsupported frozen snapshot version=${version}`)
  }

  const globalFlags = readMsv5GlobalFlags(buf)
  const directory = readMsv5SectionDirectory(buf)

  const payloadOff = buf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_OFFSET)
  const compressedLen = buf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
  if (payloadOff !== MSV5_HEADER_SIZE || payloadOff + compressedLen > buf.length) {
    throw invalidFrozenIndex('frozen snapshot payload out of bounds')
  }

  return { globalFlags, directory }
}

function decodeMsv5Sections(
  globalFlags: number,
  sections: Buffer[],
  hints?: FrozenDecodeHints,
): FrozenSnapshot {
  const core = sections[Msv5SectionId.Core]
  if (core.length !== 16) {
    throw invalidFrozenIndex('core section size mismatch')
  }
  const documentCount = core.readUInt32LE(0)
  const nextId = core.readUInt32LE(4)
  const fieldCount = core.readUInt32LE(8)
  const termCount = core.readUInt32LE(12)

  const fieldNames = readFieldNamesSection(
    sections[Msv5SectionId.FieldNames],
    0,
    fieldCount,
    sections[Msv5SectionId.FieldNames].length,
  )

  const fieldIds: { [field: string]: number } = {}
  for (let f = 0; f < fieldNames.length; f++) {
    fieldIds[fieldNames[f]] = f
  }

  const externalIds = readExternalIdsSection(
    sections[Msv5SectionId.ExternalIds],
    0,
    nextId,
    sections[Msv5SectionId.ExternalIds].length,
  )

  const storedFieldsLayout = hints != null
    ? readStoredFieldsWireSection(
        sections[Msv5SectionId.StoredFields],
        0,
        nextId,
        sections[Msv5SectionId.StoredFields].length,
        hints.storeFields,
      )
    : undefined

  const storedFields = storedFieldsLayout != null
    ? new Array(nextId)
    : readStoredFieldsSection(
        sections[Msv5SectionId.StoredFields],
        0,
        nextId,
        sections[Msv5SectionId.StoredFields].length,
      )

  const packedTermIndex = readPackedTermTreeSectionColumnar(
    sections[Msv5SectionId.TermTree],
    termCount,
  )

  const avgBuf = sections[Msv5SectionId.AvgFieldLength]
  const avgFieldLength = readFloat32Array(avgBuf, 0, avgBuf.length)

  const fieldLengthMatrix = readFieldLengthMatrixSection(
    sections[Msv5SectionId.FieldLengthMatrix],
    globalFlags,
    nextId * fieldCount,
  )

  const postings = decodeMsv5PostingsSections(
    globalFlags,
    fieldCount,
    termCount,
    nextId,
    sections[Msv5SectionId.PostMeta],
    sections[Msv5SectionId.PostFields],
    sections[Msv5SectionId.PostOptional],
    sections[Msv5SectionId.AllDocIds],
    sections[Msv5SectionId.AllFreqs],
  )

  if (postings.termCount !== termCount) {
    throw invalidFrozenIndex('core termCount mismatch with postings')
  }

  const snap: FrozenSnapshot = {
    documentCount,
    nextId,
    fieldIds,
    fieldCount,
    fieldNames,
    avgFieldLength,
    externalIds,
    storedFields,
    storedFieldsLayout,
    fieldLengthMatrix,
    treeShape: [],
    packedTermIndex,
    postings,
  }

  validateFrozenSnapshot(snap)
  return snap
}

export function decodeFrozenSnapshotMsv5(buf: Buffer, hints?: FrozenDecodeHints): FrozenSnapshot {
  const { globalFlags, directory } = validateMsv5Container(buf)
  return decodeMsv5Sections(globalFlags, loadMsv5Sections(buf, directory), hints)
}

export async function decodeFrozenSnapshotMsv5Async(
  buf: Buffer,
  hints?: FrozenDecodeHints,
): Promise<FrozenSnapshot> {
  const { globalFlags, directory } = validateMsv5Container(buf)
  return decodeMsv5Sections(globalFlags, await loadMsv5SectionsAsync(buf, directory), hints)
}
