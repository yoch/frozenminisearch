import { readU16LE, readU32LE } from '../binaryBytes'
import {
  readExternalIdsSection,
  readFieldNamesSection,
  validateFrozenSnapshot,
  type FrozenSnapshot,
} from '../binaryStructures'
import { invalidFrozenIndex } from '../frozenErrors'
import { readFieldLengthMatrixSection } from '../fieldLengthMatrixWire'
import { readFloat32Array } from '../binaryWireIo'
import { readStoredFieldsRowsSection, readStoredFieldsWireSection } from '../storedFieldsWire'
import type { Msv5SectionEntry } from './binaryMsv5Types'
import {
  MSV5_HEADER_SIZE,
  MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_OFFSET,
  Msv5SectionId,
} from './binaryMsv5Constants'
import { decodeMsv5PostingsSections } from './binaryMsv5Postings'
import { readPackedTermTreeSectionColumnar } from './packedRadixBinaryMsv5'

export type FrozenDecodeHints = {
  storeFields: readonly string[]
}

type Msv5ContainerReaders = {
  isMsv5Buffer: (buf: Uint8Array) => boolean
  readMsv5GlobalFlags: (buf: Uint8Array) => number
  readMsv5SectionDirectory: (buf: Uint8Array) => Msv5SectionEntry[]
}

export function validateMsv5Container(
  buf: Uint8Array,
  readers: Msv5ContainerReaders,
): {
  globalFlags: number
  directory: Msv5SectionEntry[]
} {
  if (!readers.isMsv5Buffer(buf)) {
    throw invalidFrozenIndex('not a frozen binary snapshot')
  }
  const version = readU16LE(buf, 4)
  if (version !== 5) {
    throw invalidFrozenIndex(`unsupported frozen snapshot version=${version}`)
  }

  const globalFlags = readers.readMsv5GlobalFlags(buf)
  const directory = readers.readMsv5SectionDirectory(buf)

  const payloadOff = readU32LE(buf, MSV5_PAYLOAD_COMPRESSED_OFFSET)
  const compressedLen = readU32LE(buf, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
  if (payloadOff !== MSV5_HEADER_SIZE || payloadOff + compressedLen > buf.length) {
    throw invalidFrozenIndex('frozen snapshot payload out of bounds')
  }

  return { globalFlags, directory }
}

export function decodeMsv5Sections(
  globalFlags: number,
  sections: Uint8Array[],
  hints?: FrozenDecodeHints,
): FrozenSnapshot {
  const core = sections[Msv5SectionId.Core]
  if (core.length !== 16) {
    throw invalidFrozenIndex('core section size mismatch')
  }
  const documentCount = readU32LE(core, 0)
  const nextId = readU32LE(core, 4)
  const fieldCount = readU32LE(core, 8)
  const termCount = readU32LE(core, 12)

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
    : readStoredFieldsRowsSection(
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
    packedTermIndex,
    postings,
  }

  validateFrozenSnapshot(snap)
  return snap
}
