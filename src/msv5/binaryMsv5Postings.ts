import type { DocIdArray, FrozenPostingsLayout } from '../frozenPostings'
import {
  FLAG_DOC_ID_16,
  FLAG_FIELD_ID_16,
  FLAG_SPARSE_LAYOUT,
} from './binaryMsv5Constants'
import {
  bufferFromView,
  invalidFrozenIndex,
  readFieldIdArray,
  readUint16Array,
  readUint32Array,
} from '../binaryIo'
import { readFreqsSection } from '../freqPostings'

export interface Msv5PostingsWire {
  flags: number
  meta: Buffer
  fields: Buffer
  optional: Buffer
  docIds: Buffer
  freqs: Buffer
}

export function msv5PostingsFlags(postings: FrozenPostingsLayout): number {
  let flags = 0
  if (postings.layout === 'sparse') flags |= FLAG_SPARSE_LAYOUT
  if (postings.docIdWidth === 16) flags |= FLAG_DOC_ID_16
  if (postings.sparseFieldIdWidth === 16) flags |= FLAG_FIELD_ID_16
  return flags
}

export function buildMsv5PostingsSections(postings: FrozenPostingsLayout): Msv5PostingsWire {
  if (postings.layout === 'dense') {
    if (postings.denseOffsets == null || postings.denseLengths == null) {
      throw invalidFrozenIndex('dense postings missing offset tables')
    }
    return {
      flags: msv5PostingsFlags(postings),
      meta: bufferFromView(postings.denseOffsets),
      fields: bufferFromView(postings.denseLengths),
      optional: Buffer.alloc(0),
      docIds: bufferFromView(postings.allDocIds),
      freqs: bufferFromView(postings.allFreqs),
    }
  }

  if (
    postings.sparseTermStarts == null
    || postings.sparseFieldIds == null
    || postings.sparseOffsets == null
    || postings.sparseLengths == null
  ) {
    throw invalidFrozenIndex('sparse postings missing tables')
  }

  const offBuf = bufferFromView(postings.sparseOffsets)
  const lenBuf = bufferFromView(postings.sparseLengths)
  const optional = Buffer.alloc(4 + offBuf.length + lenBuf.length)
  optional.writeUInt32LE(offBuf.length, 0)
  offBuf.copy(optional, 4)
  lenBuf.copy(optional, 4 + offBuf.length)

  return {
    flags: msv5PostingsFlags(postings),
    meta: bufferFromView(postings.sparseTermStarts),
    fields: bufferFromView(postings.sparseFieldIds),
    optional,
    docIds: bufferFromView(postings.allDocIds),
    freqs: bufferFromView(postings.allFreqs),
  }
}

export function decodeMsv5PostingsSections(
  flags: number,
  fieldCount: number,
  termCount: number,
  nextId: number,
  meta: Buffer,
  fields: Buffer,
  optional: Buffer,
  docIds: Buffer,
  freqs: Buffer,
): FrozenPostingsLayout {
  const sparse = (flags & FLAG_SPARSE_LAYOUT) !== 0
  const docId16 = (flags & FLAG_DOC_ID_16) !== 0
  const fieldId16 = (flags & FLAG_FIELD_ID_16) !== 0

  const readDocIds = (): DocIdArray => {
    if (docIds.length === 0) return docId16 ? new Uint16Array(0) : new Uint32Array(0)
    if (docId16) return readUint16Array(docIds, 0, docIds.length)
    return readUint32Array(docIds, 0, docIds.length)
  }

  const allDocIds = readDocIds()
  const allFreqs = readFreqsSection(freqs, flags, allDocIds.length)

  if (sparse) {
    const sparseFieldIdWidth: 8 | 16 = fieldId16 ? 16 : 8
    const offLen = optional.readUInt32LE(0)
    if (4 + offLen > optional.length) {
      throw invalidFrozenIndex('sparse optional section truncated')
    }
    const sparseOffsets = readUint32Array(optional, 4, offLen)
    const sparseLengths = readUint32Array(optional, 4 + offLen, optional.length - 4 - offLen)
    const sparseTermStarts = readUint32Array(meta, 0, meta.length)
    const sparseFieldIds = readFieldIdArray(fields, 0, fields.length, sparseFieldIdWidth)

    return {
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
  }

  const denseOffsets = readUint32Array(meta, 0, meta.length)
  const denseLengths = readUint32Array(fields, 0, fields.length)
  return {
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
