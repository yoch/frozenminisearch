import type { DocIdArray, FrozenPostingsLayout } from '../frozenPostings'
import { allocBytes, bytesFromView, readU32LE, writeU32LE } from '../binaryBytes'
import { invalidFrozenIndex } from '../frozenErrors'
import {
  readFieldIdArray,
  readUint16Array,
  readUint32Array,
} from '../binaryWireIo'
import {
  FLAG_DOC_ID_16,
  FLAG_FIELD_ID_16,
  FLAG_SPARSE_LAYOUT,
} from './binaryMsv5Constants'
import { readFreqsSection } from '../freqPostings'

export interface Msv5PostingsWire {
  flags: number
  meta: Uint8Array
  fields: Uint8Array
  optional: Uint8Array
  docIds: Uint8Array
  freqs: Uint8Array
}

function uint32WireBytes(values: ArrayLike<number>): Uint8Array {
  if (values instanceof Uint32Array) return bytesFromView(values)
  const out = allocBytes(values.length * 4)
  for (let i = 0; i < values.length; i++) {
    writeU32LE(out, i * 4, values[i] ?? 0)
  }
  return out
}

export function msv5PostingsFlags(postings: FrozenPostingsLayout): number {
  let flags = 0
  if (postings.layout === 'sparse') {
    flags |= FLAG_SPARSE_LAYOUT
    if (postings.sparseFieldIdWidth === 16) flags |= FLAG_FIELD_ID_16
  }
  if (postings.docIdWidth === 16) flags |= FLAG_DOC_ID_16
  return flags
}

export function buildMsv5PostingsSections(postings: FrozenPostingsLayout): Msv5PostingsWire {
  if (postings.layout === 'dense') {
    return {
      flags: msv5PostingsFlags(postings),
      meta: uint32WireBytes(postings.denseOffsets),
      fields: uint32WireBytes(postings.denseLengths),
      optional: allocBytes(0),
      docIds: bytesFromView(postings.allDocIds),
      freqs: bytesFromView(postings.allFreqs),
    }
  }

  const offBuf = uint32WireBytes(postings.sparseOffsets)
  const lenBuf = uint32WireBytes(postings.sparseLengths)
  const optional = allocBytes(4 + offBuf.length + lenBuf.length)
  writeU32LE(optional, 0, offBuf.length)
  optional.set(offBuf, 4)
  optional.set(lenBuf, 4 + offBuf.length)

  return {
    flags: msv5PostingsFlags(postings),
    meta: uint32WireBytes(postings.sparseTermStarts),
    fields: bytesFromView(postings.sparseFieldIds),
    optional,
    docIds: bytesFromView(postings.allDocIds),
    freqs: bytesFromView(postings.allFreqs),
  }
}

export function decodeMsv5PostingsSections(
  flags: number,
  fieldCount: number,
  termCount: number,
  nextId: number,
  meta: Uint8Array,
  fields: Uint8Array,
  optional: Uint8Array,
  docIds: Uint8Array,
  freqs: Uint8Array,
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
    const offLen = readU32LE(optional, 0)
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
    allDocIds,
    allFreqs,
    denseOffsets,
    denseLengths,
  }
}
