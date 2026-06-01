import type { DocIdArray, FrozenPostingsLayout } from './frozenPostings'
import {
  BINARY_MAGIC_V3,
  BINARY_MAGIC_V4,
  BINARY_VERSION_V3,
  BINARY_VERSION_V4,
  FLAG_DOC_ID_16,
  FLAG_FIELD_ID_16,
  FLAG_SPARSE_LAYOUT,
  HEADER_SIZE_V3,
  HEADER_SIZE_V4,
} from './binaryConstants'
import { warnDeprecatedBinaryFormat } from './binaryDeprecation'
import {
  assertBufferLength,
  assertSectionOffsets,
  crc32Buffer,
  invalidFrozenIndex,
  readFieldIdArray,
  readFloat32Array,
  readUint16Array,
  readUint32Array,
  readUint8Array,
} from './binaryIo'
import {
  readExternalIdsSection,
  readFieldNamesSection,
  readStoredFieldsSection,
  validateFrozenSnapshot,
  type FrozenSnapshot,
} from './binaryStructures'
import {
  decodeFrozenSnapshotMsv5,
  decodeFrozenSnapshotMsv5Async,
  isMsv5Buffer,
} from './msv5/binaryMsv5Decode'
import { readPackedTermTreeSection } from './packedRadixBinary'

function denseLayoutFromMSv3(
  fieldCount: number,
  termCount: number,
  nextId: number,
  postingsOffsets: Uint32Array,
  postingsLengths: Uint32Array,
  allDocIds: Uint32Array,
  allFreqs: Uint8Array,
): FrozenPostingsLayout {
  return {
    fieldCount,
    termCount,
    nextId,
    layout: 'dense',
    docIdWidth: 32,
    sparseFieldIdWidth: null,
    allDocIds,
    allFreqs,
    denseOffsets: postingsOffsets,
    denseLengths: postingsLengths,
    sparseTermStarts: null,
    sparseFieldIds: null,
    sparseOffsets: null,
    sparseLengths: null,
  }
}

/** @deprecated MSv3 decode path; still used by {@link decodeFrozenSnapshot}. */
function decodeMSv3(buf: Buffer): FrozenSnapshot {
  warnDeprecatedBinaryFormat('MSv3')
  assertBufferLength(buf, HEADER_SIZE_V3)

  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)
  if (magic !== BINARY_MAGIC_V3 || version !== BINARY_VERSION_V3) {
    throw invalidFrozenIndex(`magic=${magic} version=${version}`)
  }

  const expectedCrc = buf.readUInt32LE(8)
  const actualCrc = crc32Buffer(buf, HEADER_SIZE_V3, buf.length)
  if (expectedCrc !== actualCrc) {
    throw invalidFrozenIndex(`CRC mismatch (expected ${expectedCrc}, got ${actualCrc})`)
  }

  const coreOff = buf.readUInt32LE(12)
  const fieldNamesOff = buf.readUInt32LE(16)
  const externalIdsOff = buf.readUInt32LE(20)
  const storedOff = buf.readUInt32LE(24)
  const treeOff = buf.readUInt32LE(28)
  const avgOff = buf.readUInt32LE(32)
  const flOff = buf.readUInt32LE(36)
  const postOffOff = buf.readUInt32LE(40)
  const postLenOff = buf.readUInt32LE(44)
  const docIdsOff = buf.readUInt32LE(48)
  const freqsOff = buf.readUInt32LE(52)
  const endOff = buf.readUInt32LE(56)

  const sectionOffsets = [
    coreOff, fieldNamesOff, externalIdsOff, storedOff, treeOff,
    avgOff, flOff, postOffOff, postLenOff, docIdsOff, freqsOff, endOff,
  ]
  assertSectionOffsets(buf, HEADER_SIZE_V3, sectionOffsets)

  if (coreOff + 16 > fieldNamesOff) {
    throw invalidFrozenIndex('core section size mismatch')
  }
  const documentCount = buf.readUInt32LE(coreOff)
  const nextId = buf.readUInt32LE(coreOff + 4)
  const fieldCount = buf.readUInt32LE(coreOff + 8)
  const termCount = buf.readUInt32LE(coreOff + 12)

  const fieldNames = readFieldNamesSection(buf, fieldNamesOff, fieldCount, externalIdsOff)

  const fieldIds: { [field: string]: number } = {}
  for (let f = 0; f < fieldNames.length; f++) {
    fieldIds[fieldNames[f]] = f
  }

  const externalIds = readExternalIdsSection(buf, externalIdsOff, nextId, storedOff)
  const storedFields = readStoredFieldsSection(buf, storedOff, nextId, treeOff)

  const packedTermIndex = readPackedTermTreeSection(buf, treeOff, avgOff, termCount)

  const avgFieldLength = readFloat32Array(buf, avgOff, flOff - avgOff)
  const fieldLengthMatrix = readUint32Array(buf, flOff, postOffOff - flOff)

  const slotCount = termCount * fieldCount
  if ((postLenOff - postOffOff) !== slotCount * 4 || (docIdsOff - postLenOff) !== slotCount * 4) {
    throw invalidFrozenIndex('postings section size mismatch')
  }

  const postingsOffsets = readUint32Array(buf, postOffOff, slotCount * 4)
  const postingsLengths = readUint32Array(buf, postLenOff, slotCount * 4)
  const allDocIds = readUint32Array(buf, docIdsOff, freqsOff - docIdsOff)
  const allFreqs = readUint8Array(buf, freqsOff, endOff - freqsOff)

  const postings = denseLayoutFromMSv3(
    fieldCount, termCount, nextId, postingsOffsets, postingsLengths, allDocIds, allFreqs,
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
    fieldLengthMatrix,
    treeShape: [],
    packedTermIndex,
    postings,
  }

  validateFrozenSnapshot(snap)
  return snap
}

/** @deprecated MSv4 decode path; still used by {@link decodeFrozenSnapshot}. */
function decodeMSv4(buf: Buffer): FrozenSnapshot {
  warnDeprecatedBinaryFormat('MSv4')
  assertBufferLength(buf, HEADER_SIZE_V4)

  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)
  if (magic !== BINARY_MAGIC_V4 || version !== BINARY_VERSION_V4) {
    throw invalidFrozenIndex(`magic=${magic} version=${version}`)
  }

  const flags = buf.readUInt16LE(6)
  const expectedCrc = buf.readUInt32LE(8)
  const actualCrc = crc32Buffer(buf, HEADER_SIZE_V4, buf.length)
  if (expectedCrc !== actualCrc) {
    throw invalidFrozenIndex(`CRC mismatch (expected ${expectedCrc}, got ${actualCrc})`)
  }

  const coreOff = buf.readUInt32LE(12)
  const fieldNamesOff = buf.readUInt32LE(16)
  const externalIdsOff = buf.readUInt32LE(20)
  const storedOff = buf.readUInt32LE(24)
  const treeOff = buf.readUInt32LE(28)
  const avgOff = buf.readUInt32LE(32)
  const flOff = buf.readUInt32LE(36)
  const postMetaOff = buf.readUInt32LE(40)
  const postFieldsOff = buf.readUInt32LE(44)
  const postOffOff = buf.readUInt32LE(48)
  const postLenOff = buf.readUInt32LE(52)
  const docIdsOff = buf.readUInt32LE(56)
  const freqsOff = buf.readUInt32LE(60)
  const endOff = buf.readUInt32LE(64)

  const sectionOffsets = [
    coreOff, fieldNamesOff, externalIdsOff, storedOff, treeOff,
    avgOff, flOff, postMetaOff, postFieldsOff, postOffOff, postLenOff, docIdsOff, freqsOff, endOff,
  ]
  assertSectionOffsets(buf, HEADER_SIZE_V4, sectionOffsets)

  if (coreOff + 16 > fieldNamesOff) {
    throw invalidFrozenIndex('core section size mismatch')
  }
  const documentCount = buf.readUInt32LE(coreOff)
  const nextId = buf.readUInt32LE(coreOff + 4)
  const fieldCount = buf.readUInt32LE(coreOff + 8)
  const termCount = buf.readUInt32LE(coreOff + 12)

  const fieldNames = readFieldNamesSection(buf, fieldNamesOff, fieldCount, externalIdsOff)

  const fieldIds: { [field: string]: number } = {}
  for (let f = 0; f < fieldNames.length; f++) {
    fieldIds[fieldNames[f]] = f
  }

  const externalIds = readExternalIdsSection(buf, externalIdsOff, nextId, storedOff)
  const storedFields = readStoredFieldsSection(buf, storedOff, nextId, treeOff)

  const packedTermIndex = readPackedTermTreeSection(buf, treeOff, avgOff, termCount)

  const avgFieldLength = readFloat32Array(buf, avgOff, flOff - avgOff)
  const fieldLengthMatrix = readUint32Array(buf, flOff, postMetaOff - flOff)

  const sparse = (flags & FLAG_SPARSE_LAYOUT) !== 0
  const docId16 = (flags & FLAG_DOC_ID_16) !== 0
  const fieldId16 = (flags & FLAG_FIELD_ID_16) !== 0
  const allFreqs = readUint8Array(buf, freqsOff, endOff - freqsOff)

  let postings: FrozenPostingsLayout

  if (sparse) {
    const sparseFieldIdWidth: 8 | 16 = fieldId16 ? 16 : 8
    const sparseTermStarts = readUint32Array(buf, postMetaOff, postFieldsOff - postMetaOff)
    const sparseFieldIds = readFieldIdArray(
      buf, postFieldsOff, postOffOff - postFieldsOff, sparseFieldIdWidth,
    )
    const sparseOffsets = readUint32Array(buf, postOffOff, postLenOff - postOffOff)
    const sparseLengths = readUint32Array(buf, postLenOff, docIdsOff - postLenOff)
    const allDocIds: DocIdArray = docId16
      ? readUint16Array(buf, docIdsOff, freqsOff - docIdsOff)
      : readUint32Array(buf, docIdsOff, freqsOff - docIdsOff)
    postings = {
      fieldCount,
      termCount,
      nextId,
      layout: 'sparse',
      docIdWidth: docId16 ? 16 : 32,
      sparseFieldIdWidth,
      allDocIds,
      allFreqs,
      denseOffsets: null,
      denseLengths: null,
      sparseTermStarts,
      sparseFieldIds,
      sparseOffsets,
      sparseLengths,
    }
  } else {
    const denseOffsets = readUint32Array(buf, postMetaOff, postFieldsOff - postMetaOff)
    const denseLengths = readUint32Array(buf, postFieldsOff, postOffOff - postFieldsOff)
    const allDocIds: DocIdArray = docId16
      ? readUint16Array(buf, docIdsOff, freqsOff - docIdsOff)
      : readUint32Array(buf, docIdsOff, freqsOff - docIdsOff)
    postings = {
      fieldCount,
      termCount,
      nextId,
      layout: 'dense',
      docIdWidth: docId16 ? 16 : 32,
      sparseFieldIdWidth: null,
      allDocIds,
      allFreqs,
      denseOffsets,
      denseLengths,
      sparseTermStarts: null,
      sparseFieldIds: null,
      sparseOffsets: null,
      sparseLengths: null,
    }
  }

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
    fieldLengthMatrix,
    treeShape: [],
    packedTermIndex,
    postings,
  }

  validateFrozenSnapshot(snap)
  return snap
}

/**
 * Decode a frozen snapshot buffer (MSv5, or deprecated MSv4 / MSv3).
 * Loading MSv3/MSv4 emits a one-time {@link process.emitWarning} `DeprecationWarning`.
 */
export function decodeFrozenSnapshot(buf: Buffer): FrozenSnapshot {
  assertBufferLength(buf, 8)
  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)

  if (isMsv5Buffer(buf) && version === 5) {
    return decodeFrozenSnapshotMsv5(buf)
  }
  if (magic === BINARY_MAGIC_V4 && version === BINARY_VERSION_V4) {
    return decodeMSv4(buf)
  }
  if (magic === BINARY_MAGIC_V3 && version === BINARY_VERSION_V3) {
    return decodeMSv3(buf)
  }
  if (magic === 'MSv1' || magic === 'MSv2') {
    throw invalidFrozenIndex(
      `${magic} is no longer supported; re-save with saveBinarySync() (MSv5)`,
    )
  }
  throw invalidFrozenIndex(`magic=${magic} version=${version}`)
}

/**
 * Async decode (streaming zstd for MSv5). Non-MSv5 buffers use {@link decodeFrozenSnapshot}
 * (deprecated MSv3/MSv4 included).
 */
export async function decodeFrozenSnapshotAsync(buf: Buffer): Promise<FrozenSnapshot> {
  assertBufferLength(buf, 8)
  const version = buf.readUInt16LE(4)

  if (isMsv5Buffer(buf) && version === 5) {
    return decodeFrozenSnapshotMsv5Async(buf)
  }
  return decodeFrozenSnapshot(buf)
}
