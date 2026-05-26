import { LEAF } from './SearchableMap/TreeIterator'
import type { RadixTree } from './SearchableMap/types'

export const BINARY_MAGIC_V1 = 'MSv1'
export const BINARY_VERSION_V1 = 1
export const BINARY_MAGIC_V2 = 'MSv2'
export const BINARY_VERSION_V2 = 2

const HEADER_SIZE_V1 = 28
const HEADER_SIZE_V2 = 48
const FREQ_UINT8 = 0
const FREQ_UINT16 = 1
const MAX_DOC_ID = 0xfffffffe

export type TreeShape = Array<[string, number | TreeShape]>

/** Flat frozen snapshot (runtime + MSv2 on disk). */
export interface FrozenSnapshot {
  documentCount: number
  nextId: number
  fieldIds: { [fieldName: string]: number }
  fieldCount: number
  avgFieldLength: Float32Array
  externalIds: unknown[]
  storedFields: (Record<string, unknown> | undefined)[]
  fieldLengthMatrix: Uint32Array
  terms: string[]
  treeShape: TreeShape
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
}

function invalidFrozenIndex (detail: string): Error {
  return new Error(`Invalid frozen index: ${detail}`)
}

function assertBufferLength (buf: Buffer, min: number): void {
  if (buf.length < min) {
    throw invalidFrozenIndex(`buffer too short (${buf.length} < ${min})`)
  }
}

/**
 * Validate that all section start offsets and the end sentinel are within
 * [headerSize, buf.length] and strictly non-decreasing.
 * Pass the end sentinel as the last element of `offsets`.
 */
function assertSectionOffsets (buf: Buffer, headerSize: number, offsets: number[]): void {
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] < headerSize || offsets[i] > buf.length) {
      throw invalidFrozenIndex(`section offset ${i} out of bounds`)
    }
    if (i > 0 && offsets[i] < offsets[i - 1]) {
      throw invalidFrozenIndex('section offsets not monotonic')
    }
  }
}

function validateTreeShape (shape: TreeShape, termCount: number): void {
  if (!Array.isArray(shape)) {
    throw invalidFrozenIndex('treeShape node must be an array')
  }
  for (const entry of shape) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw invalidFrozenIndex('treeShape entry must be a [key, value] pair')
    }
    const [key, value] = entry
    if (key === LEAF) {
      const idx = value as number
      if (!Number.isInteger(idx) || idx < 0 || idx >= termCount) {
        throw invalidFrozenIndex(`treeShape leaf term index out of range: ${idx}`)
      }
    } else {
      validateTreeShape(value as TreeShape, termCount)
    }
  }
}

/**
 * Numeric/structural invariants shared by both the decode path (untrusted binary)
 * and the build path (trusted internal code).  Does NOT traverse the radix tree
 * shape so it can be used in {@link assembleFrozen} without serialising the tree.
 */
export function validateFrozenSnapshotNumeric (snap: {
  fieldCount: number
  nextId: number
  documentCount: number
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
  fieldLengthMatrix: Uint32Array
  avgFieldLength: Float32Array
  terms: string[]
  fieldIds: { [field: string]: number }
}): void {
  if (snap.fieldCount <= 0) {
    throw invalidFrozenIndex('fieldCount must be positive')
  }
  if (snap.nextId < 0 || snap.nextId >= 0xffffffff) {
    throw invalidFrozenIndex('nextId out of range')
  }
  if (snap.documentCount < 0 || snap.documentCount > snap.nextId) {
    throw invalidFrozenIndex('documentCount inconsistent with nextId')
  }

  const termCount = snap.terms.length
  const slotCount = termCount * snap.fieldCount

  if (snap.postingsOffsets.length !== slotCount || snap.postingsLengths.length !== slotCount) {
    throw invalidFrozenIndex('postings slot count mismatch')
  }
  if (snap.allDocIds.length !== snap.allFreqs.length) {
    throw invalidFrozenIndex('allDocIds and allFreqs length mismatch')
  }
  if (snap.fieldLengthMatrix.length !== snap.nextId * snap.fieldCount) {
    throw invalidFrozenIndex('fieldLengthMatrix size mismatch')
  }
  if (snap.avgFieldLength.length !== snap.fieldCount) {
    throw invalidFrozenIndex('avgFieldLength size mismatch')
  }

  for (let slot = 0; slot < slotCount; slot++) {
    const off = snap.postingsOffsets[slot]
    const len = snap.postingsLengths[slot]
    if (off + len > snap.allDocIds.length) {
      throw invalidFrozenIndex(`posting slot ${slot} exceeds allDocIds bounds`)
    }
    for (let i = 0; i < len; i++) {
      const docId = snap.allDocIds[off + i]
      if (docId >= snap.nextId) {
        throw invalidFrozenIndex(`posting docId ${docId} >= nextId ${snap.nextId}`)
      }
      if (docId > MAX_DOC_ID) {
        throw invalidFrozenIndex(`posting docId ${docId} is reserved`)
      }
    }
  }

  const indexedFields = Object.keys(snap.fieldIds)
  if (indexedFields.length !== snap.fieldCount) {
    throw invalidFrozenIndex('fieldIds count mismatch')
  }
  for (let f = 0; f < snap.fieldCount; f++) {
    const found = indexedFields.some((name) => snap.fieldIds[name] === f)
    if (!found) {
      throw invalidFrozenIndex(`missing field id ${f}`)
    }
  }
}

/** Validate structural invariants of a decoded or assembled frozen snapshot. */
export function validateFrozenSnapshot (snap: FrozenSnapshot): void {
  validateFrozenSnapshotNumeric(snap)
  validateTreeShape(snap.treeShape, snap.terms.length)
}

function readUint32Array (buf: Buffer, offset: number, byteLength: number): Uint32Array {
  if (byteLength === 0) return new Uint32Array(0)
  if (byteLength % 4 !== 0) {
    throw invalidFrozenIndex('uint32 section length not aligned')
  }
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint32 section read past buffer end')
  }
  if (offset % 4 === 0) {
    return new Uint32Array(buf.buffer, buf.byteOffset + offset, byteLength / 4)
  }
  const out = new Uint32Array(byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(offset + i * 4)
  return out
}

function readUint8Array (buf: Buffer, offset: number, byteLength: number): Uint8Array {
  if (byteLength === 0) return new Uint8Array(0)
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint8 section read past buffer end')
  }
  return new Uint8Array(buf.buffer, buf.byteOffset + offset, byteLength)
}

function readFloat32Array (buf: Buffer, offset: number, byteLength: number): Float32Array {
  if (byteLength === 0) return new Float32Array(0)
  if (byteLength % 4 !== 0) {
    throw invalidFrozenIndex('float32 section length not aligned')
  }
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('float32 section read past buffer end')
  }
  if (offset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset + offset, byteLength / 4)
  }
  const out = new Float32Array(byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(offset + i * 4)
  return out
}

function writeView (buf: Buffer, offset: number, view: ArrayBufferView): void {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  for (let i = 0; i < bytes.length; i++) {
    buf[offset + i] = bytes[i]
  }
}

export function encodeFrozenSnapshot (snap: FrozenSnapshot): Buffer {
  validateFrozenSnapshot(snap)

  const metaJson = Buffer.from(JSON.stringify({
    documentCount: snap.documentCount,
    nextId: snap.nextId,
    fieldCount: snap.fieldCount,
    fieldIds: snap.fieldIds,
    externalIds: snap.externalIds,
    storedFields: snap.storedFields,
    treeShape: snap.treeShape
  }), 'utf8')

  const termBufs = snap.terms.map((term) => Buffer.from(term, 'utf8'))
  const dictHeaderLen = 4 + snap.terms.length * 4
  const dictBodyLen = termBufs.reduce((sum, b) => sum + b.length, 0)
  const dictLen = dictHeaderLen + dictBodyLen

  const sectionSizes = [
    metaJson.length,
    snap.avgFieldLength.byteLength,
    snap.fieldLengthMatrix.byteLength,
    dictLen,
    snap.postingsOffsets.byteLength,
    snap.postingsLengths.byteLength,
    snap.allDocIds.byteLength,
    snap.allFreqs.byteLength
  ]

  const totalSize = HEADER_SIZE_V2 + sectionSizes.reduce((a, b) => a + b, 0)
  const out = Buffer.alloc(totalSize)

  out.write(BINARY_MAGIC_V2, 0, 4, 'ascii')
  out.writeUInt16LE(BINARY_VERSION_V2, 4)
  out.writeUInt16LE(0, 6)

  let sectionOff = HEADER_SIZE_V2
  for (let i = 0; i < sectionSizes.length; i++) {
    out.writeUInt32LE(sectionOff, 8 + i * 4)
    sectionOff += sectionSizes[i]
  }
  out.writeUInt32LE(sectionOff, 8 + sectionSizes.length * 4)

  let off = HEADER_SIZE_V2
  metaJson.copy(out, off); off += metaJson.length
  writeView(out, off, snap.avgFieldLength); off += snap.avgFieldLength.byteLength
  writeView(out, off, snap.fieldLengthMatrix); off += snap.fieldLengthMatrix.byteLength

  out.writeUInt32LE(snap.terms.length, off)
  for (let i = 0; i < termBufs.length; i++) {
    out.writeUInt32LE(termBufs[i].length, off + 4 + i * 4)
  }
  let dictBodyOff = off + dictHeaderLen
  for (const termBuf of termBufs) {
    termBuf.copy(out, dictBodyOff)
    dictBodyOff += termBuf.length
  }
  off += dictLen

  writeView(out, off, snap.postingsOffsets); off += snap.postingsOffsets.byteLength
  writeView(out, off, snap.postingsLengths); off += snap.postingsLengths.byteLength
  writeView(out, off, snap.allDocIds); off += snap.allDocIds.byteLength
  writeView(out, off, snap.allFreqs)

  return out
}

/** Encode MSv1 for tests and legacy read compatibility. */
export function encodeMSv1Snapshot (snap: FrozenSnapshot): Buffer {
  validateFrozenSnapshot(snap)

  const metaJson = Buffer.from(JSON.stringify({
    documentCount: snap.documentCount,
    nextId: snap.nextId,
    fieldCount: snap.fieldCount,
    fieldIds: snap.fieldIds,
    externalIds: snap.externalIds,
    storedFields: snap.storedFields,
    treeShape: snap.treeShape
  }), 'utf8')

  const termBufs = snap.terms.map((term) => Buffer.from(term, 'utf8'))
  const dictHeaderLen = 4 + snap.terms.length * 4
  const dictBodyLen = termBufs.reduce((sum, b) => sum + b.length, 0)
  const dictLen = dictHeaderLen + dictBodyLen

  const postingsChunks: Buffer[] = []
  const termCount = snap.terms.length
  const fieldCount = snap.fieldCount

  for (let ti = 0; ti < termCount; ti++) {
    const base = ti * fieldCount
    const chunk = Buffer.alloc(2)
    chunk.writeUInt16LE(fieldCount, 0)
    postingsChunks.push(chunk)

    for (let f = 0; f < fieldCount; f++) {
      const docLen = snap.postingsLengths[base + f]
      const off = snap.postingsOffsets[base + f]
      const header = Buffer.alloc(9)
      header.writeUInt32LE(docLen, 0)
      header.writeUInt32LE(docLen, 4)
      header.writeUInt8(FREQ_UINT8, 8)
      postingsChunks.push(header)

      if (docLen > 0) {
        const docIds = Buffer.alloc(docLen * 4)
        for (let d = 0; d < docLen; d++) {
          docIds.writeUInt32LE(snap.allDocIds[off + d], d * 4)
        }
        postingsChunks.push(docIds)

        const freqs = Buffer.alloc(docLen)
        for (let d = 0; d < docLen; d++) {
          freqs.writeUInt8(snap.allFreqs[off + d], d)
        }
        postingsChunks.push(freqs)
      }
    }
  }

  const postingsBuf = Buffer.concat(postingsChunks)
  const sectionSizes = [
    metaJson.length,
    snap.avgFieldLength.byteLength,
    snap.fieldLengthMatrix.byteLength,
    dictLen,
    postingsBuf.length
  ]
  const totalSize = HEADER_SIZE_V1 + sectionSizes.reduce((a, b) => a + b, 0)
  const out = Buffer.alloc(totalSize)

  out.write(BINARY_MAGIC_V1, 0, 4, 'ascii')
  out.writeUInt16LE(BINARY_VERSION_V1, 4)
  out.writeUInt16LE(0, 6)

  let sectionOff = HEADER_SIZE_V1
  for (let i = 0; i < sectionSizes.length; i++) {
    out.writeUInt32LE(sectionOff, 8 + i * 4)
    sectionOff += sectionSizes[i]
  }

  let off = HEADER_SIZE_V1
  metaJson.copy(out, off); off += metaJson.length
  writeView(out, off, snap.avgFieldLength); off += snap.avgFieldLength.byteLength
  writeView(out, off, snap.fieldLengthMatrix); off += snap.fieldLengthMatrix.byteLength

  out.writeUInt32LE(snap.terms.length, off)
  for (let i = 0; i < termBufs.length; i++) {
    out.writeUInt32LE(termBufs[i].length, off + 4 + i * 4)
  }
  let dictBodyOff = off + dictHeaderLen
  for (const termBuf of termBufs) {
    termBuf.copy(out, dictBodyOff)
    dictBodyOff += termBuf.length
  }
  off += dictLen

  postingsBuf.copy(out, off)

  return out
}

function decodeMSv2 (buf: Buffer): FrozenSnapshot {
  assertBufferLength(buf, HEADER_SIZE_V2)

  const metaOff = buf.readUInt32LE(8)
  const avgOff = buf.readUInt32LE(12)
  const flOff = buf.readUInt32LE(16)
  const dictOff = buf.readUInt32LE(20)
  const postOffOff = buf.readUInt32LE(24)
  const postLenOff = buf.readUInt32LE(28)
  const docIdsOff = buf.readUInt32LE(32)
  const freqsOff = buf.readUInt32LE(36)
  const endOff = buf.readUInt32LE(40)

  const sectionOffsets = [metaOff, avgOff, flOff, dictOff, postOffOff, postLenOff, docIdsOff, freqsOff, endOff]
  assertSectionOffsets(buf, HEADER_SIZE_V2, sectionOffsets)

  const meta = JSON.parse(buf.toString('utf8', metaOff, avgOff)) as {
    documentCount: number
    nextId: number
    fieldCount: number
    fieldIds: { [fieldName: string]: number }
    externalIds: unknown[]
    storedFields: (Record<string, unknown> | undefined)[]
    treeShape: TreeShape
  }

  const avgFieldLength = readFloat32Array(buf, avgOff, flOff - avgOff)
  const fieldLengthMatrix = readUint32Array(buf, flOff, dictOff - flOff)

  assertBufferLength(buf, dictOff + 4)
  const termCount = buf.readUInt32LE(dictOff)
  const dictLengthsOff = dictOff + 4
  const dictBodyOff = dictLengthsOff + termCount * 4
  if (dictBodyOff > dictOff + (postOffOff - dictOff)) {
    throw invalidFrozenIndex('dictionary section overflows into postings')
  }

  const terms: string[] = []
  let o = dictBodyOff
  for (let i = 0; i < termCount; i++) {
    const lenOff = dictLengthsOff + i * 4
    if (lenOff + 4 > postOffOff) {
      throw invalidFrozenIndex('dictionary length table out of bounds')
    }
    const len = buf.readUInt32LE(lenOff)
    if (o + len > postOffOff) {
      throw invalidFrozenIndex('dictionary term bytes out of bounds')
    }
    terms.push(buf.toString('utf8', o, o + len))
    o += len
  }

  const slotCount = termCount * meta.fieldCount
  if ((postLenOff - postOffOff) !== slotCount * 4 || (docIdsOff - postLenOff) !== slotCount * 4) {
    throw invalidFrozenIndex('postings section size mismatch')
  }

  const postingsOffsets = readUint32Array(buf, postOffOff, slotCount * 4)
  const postingsLengths = readUint32Array(buf, postLenOff, slotCount * 4)
  const allDocIds = readUint32Array(buf, docIdsOff, freqsOff - docIdsOff)
  const allFreqs = readUint8Array(buf, freqsOff, endOff - freqsOff)

  const snap: FrozenSnapshot = {
    documentCount: meta.documentCount,
    nextId: meta.nextId,
    fieldIds: meta.fieldIds,
    fieldCount: meta.fieldCount,
    avgFieldLength,
    externalIds: meta.externalIds,
    storedFields: meta.storedFields,
    fieldLengthMatrix,
    terms,
    treeShape: meta.treeShape,
    postingsOffsets,
    postingsLengths,
    allDocIds,
    allFreqs
  }

  validateFrozenSnapshot(snap)
  return snap
}

function decodeMSv1 (buf: Buffer): FrozenSnapshot {
  assertBufferLength(buf, HEADER_SIZE_V1)

  const metaOff = buf.readUInt32LE(8)
  const avgOff = buf.readUInt32LE(12)
  const flOff = buf.readUInt32LE(16)
  const dictOff = buf.readUInt32LE(20)
  const postOff = buf.readUInt32LE(24)

  const sectionOffsets = [metaOff, avgOff, flOff, dictOff, postOff, buf.length]
  assertSectionOffsets(buf, HEADER_SIZE_V1, sectionOffsets)

  const meta = JSON.parse(buf.toString('utf8', metaOff, avgOff)) as {
    documentCount: number
    nextId: number
    fieldCount: number
    fieldIds: { [fieldName: string]: number }
    externalIds: unknown[]
    storedFields: (Record<string, unknown> | undefined)[]
    treeShape: TreeShape
  }

  const avgFieldLength = readFloat32Array(buf, avgOff, flOff - avgOff)
  const fieldLengthMatrix = readUint32Array(buf, flOff, dictOff - flOff)

  assertBufferLength(buf, dictOff + 4)
  const termCount = buf.readUInt32LE(dictOff)
  const terms: string[] = []
  let o = dictOff + 4 + termCount * 4
  for (let i = 0; i < termCount; i++) {
    const lenOff = dictOff + 4 + i * 4
    if (lenOff + 4 > postOff) {
      throw invalidFrozenIndex('MSv1 dictionary length table out of bounds')
    }
    const len = buf.readUInt32LE(lenOff)
    if (o + len > postOff) {
      throw invalidFrozenIndex('MSv1 dictionary term bytes out of bounds')
    }
    terms.push(buf.toString('utf8', o, o + len))
    o += len
  }

  const fieldCount = meta.fieldCount
  if (fieldCount <= 0) {
    throw invalidFrozenIndex('MSv1 fieldCount must be positive')
  }

  const slotCount = termCount * fieldCount
  const postingsOffsets = new Uint32Array(slotCount)
  const postingsLengths = new Uint32Array(slotCount)
  const docIdChunks: number[] = []
  const freqChunks: number[] = []

  o = postOff
  for (let ti = 0; ti < termCount; ti++) {
    if (o + 2 > buf.length) {
      throw invalidFrozenIndex('MSv1 postings truncated at term header')
    }
    const fc = buf.readUInt16LE(o); o += 2
    if (fc > fieldCount) {
      throw invalidFrozenIndex(`MSv1 field count ${fc} exceeds fieldCount ${fieldCount}`)
    }
    const base = ti * fieldCount

    for (let f = 0; f < fc; f++) {
      if (o + 9 > buf.length) {
        throw invalidFrozenIndex('MSv1 posting header truncated')
      }
      buf.readUInt32LE(o); o += 4
      const docLen = buf.readUInt32LE(o); o += 4
      postingsLengths[base + f] = docLen

      if (docLen === 0) {
        postingsOffsets[base + f] = 0
        if (o + 1 > buf.length) {
          throw invalidFrozenIndex('MSv1 empty posting kind truncated')
        }
        o += 1
        continue
      }

      postingsOffsets[base + f] = docIdChunks.length
      if (o + 1 > buf.length) {
        throw invalidFrozenIndex('MSv1 posting kind truncated')
      }
      const kind = buf.readUInt8(o); o += 1

      if (kind !== FREQ_UINT8 && kind !== FREQ_UINT16) {
        throw invalidFrozenIndex(`MSv1 unknown frequency kind ${kind}`)
      }

      if (o + docLen * 4 > buf.length) {
        throw invalidFrozenIndex('MSv1 docIds truncated')
      }
      for (let d = 0; d < docLen; d++) {
        docIdChunks.push(buf.readUInt32LE(o + d * 4))
      }
      o += docLen * 4

      const freqElem = kind === FREQ_UINT8 ? 1 : 2
      if (o + docLen * freqElem > buf.length) {
        throw invalidFrozenIndex('MSv1 frequencies truncated')
      }
      for (let d = 0; d < docLen; d++) {
        let freq: number
        if (kind === FREQ_UINT8) freq = buf.readUInt8(o + d)
        else freq = buf.readUInt16LE(o + d * 2)
        freqChunks.push(freq > 255 ? 255 : freq)
      }
      o += docLen * freqElem
    }

    for (let f = fc; f < fieldCount; f++) {
      postingsOffsets[base + f] = docIdChunks.length
      postingsLengths[base + f] = 0
    }
  }

  if (o > buf.length) {
    throw invalidFrozenIndex('MSv1 postings read past buffer end')
  }

  const snap: FrozenSnapshot = {
    documentCount: meta.documentCount,
    nextId: meta.nextId,
    fieldIds: meta.fieldIds,
    fieldCount,
    avgFieldLength,
    externalIds: meta.externalIds,
    storedFields: meta.storedFields,
    fieldLengthMatrix,
    terms,
    treeShape: meta.treeShape,
    postingsOffsets,
    postingsLengths,
    allDocIds: new Uint32Array(docIdChunks),
    allFreqs: new Uint8Array(freqChunks)
  }

  validateFrozenSnapshot(snap)
  return snap
}

export function decodeFrozenSnapshot (buf: Buffer): FrozenSnapshot {
  assertBufferLength(buf, 8)
  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)

  if (magic === BINARY_MAGIC_V2 && version === BINARY_VERSION_V2) {
    return decodeMSv2(buf)
  }
  if (magic === BINARY_MAGIC_V1 && version === BINARY_VERSION_V1) {
    return decodeMSv1(buf)
  }
  throw invalidFrozenIndex(`magic=${magic} version=${version}`)
}

export function deserializeTermIndexTree (shape: TreeShape): RadixTree<number> {
  const tree = new Map() as RadixTree<number>
  for (const [key, value] of shape) {
    if (key === LEAF) {
      tree.set(LEAF, value as number)
    } else {
      tree.set(key, deserializeTermIndexTree(value as TreeShape))
    }
  }
  return tree
}

export function serializeTermIndexTree (tree: RadixTree<number>): TreeShape {
  const shape: TreeShape = []
  for (const [key, val] of tree) {
    if (key === LEAF) {
      shape.push([key, val as number])
    } else {
      shape.push([key, serializeTermIndexTree(val as RadixTree<number>)])
    }
  }
  return shape
}
