import { LEAF } from './SearchableMap/TreeIterator'
import type { RadixTree } from './SearchableMap/types'

export const BINARY_MAGIC_V3 = 'MSv3'
export const BINARY_VERSION_V3 = 3

const HEADER_SIZE_V3 = 64
const MAX_DOC_ID = 0xfffffffe

const ID_TAG_EMPTY = 0
const ID_TAG_NUMBER = 1
const ID_TAG_STRING = 2
const ID_TAG_JSON = 3

const TREE_NODE_LEAF = 0
const TREE_NODE_EDGE = 1

export type TreeShape = Array<[string, number | TreeShape]>

/** Flat frozen snapshot (runtime + MSv3 on disk). */
export interface FrozenSnapshot {
  documentCount: number
  nextId: number
  fieldIds: { [fieldName: string]: number }
  fieldCount: number
  /** Field names in index order (0..fieldCount-1); populated on decode. */
  fieldNames?: string[]
  avgFieldLength: Float32Array
  externalIds: unknown[]
  storedFields: (Record<string, unknown> | undefined)[]
  fieldLengthMatrix: Uint32Array
  terms: string[]
  treeShape: TreeShape
  /** Populated on decode; preferred over deserializing {@link treeShape}. */
  termTree?: RadixTree<number>
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
}

function invalidFrozenIndex(detail: string): Error {
  return new Error(`Invalid frozen index: ${detail}`)
}

function assertBufferLength(buf: Buffer, min: number): void {
  if (buf.length < min) {
    throw invalidFrozenIndex(`buffer too short (${buf.length} < ${min})`)
  }
}

function assertSectionOffsets(buf: Buffer, headerSize: number, offsets: number[]): void {
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] < headerSize || offsets[i] > buf.length) {
      throw invalidFrozenIndex(`section offset ${i} out of bounds`)
    }
    if (i > 0 && offsets[i] < offsets[i - 1]) {
      throw invalidFrozenIndex('section offsets not monotonic')
    }
  }
}

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[i] = c
}

/** CRC-32 IEEE (same polynomial as zlib / Ethernet). */
export function crc32Buffer(buf: Buffer, start = 0, end = buf.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function validateTreeShape(shape: TreeShape, termCount: number): void {
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
 * and the build path (trusted internal code).
 */
export function validateFrozenSnapshotNumeric(snap: {
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
    const found = indexedFields.some(name => snap.fieldIds[name] === f)
    if (!found) {
      throw invalidFrozenIndex(`missing field id ${f}`)
    }
  }
}

/** Validate structural invariants of a decoded or assembled frozen snapshot. */
export function validateFrozenSnapshot(snap: FrozenSnapshot): void {
  validateFrozenSnapshotNumeric(snap)
  validateTreeShape(snap.treeShape, snap.terms.length)
}

export function fieldNamesFromFieldIds(fieldIds: { [field: string]: number }): string[] {
  const names = Object.keys(fieldIds)
  names.sort((a, b) => fieldIds[a] - fieldIds[b])
  return names
}

function readUint32Array(buf: Buffer, offset: number, byteLength: number): Uint32Array {
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

function readUint8Array(buf: Buffer, offset: number, byteLength: number): Uint8Array {
  if (byteLength === 0) return new Uint8Array(0)
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint8 section read past buffer end')
  }
  return new Uint8Array(buf.buffer, buf.byteOffset + offset, byteLength)
}

function readFloat32Array(buf: Buffer, offset: number, byteLength: number): Float32Array {
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

function writeView(buf: Buffer, offset: number, view: ArrayBufferView): void {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  for (let i = 0; i < bytes.length; i++) {
    buf[offset + i] = bytes[i]
  }
}

function writeLengthPrefixedUtf8(chunks: Buffer[], str: string): void {
  const body = Buffer.from(str, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  chunks.push(header, body)
}

function readLengthPrefixedUtf8(buf: Buffer, offset: number): { value: string, next: number } {
  if (offset + 4 > buf.length) {
    throw invalidFrozenIndex('length-prefixed string header truncated')
  }
  const len = buf.readUInt32LE(offset)
  const start = offset + 4
  const end = start + len
  if (end > buf.length) {
    throw invalidFrozenIndex('length-prefixed string body out of bounds')
  }
  return { value: buf.toString('utf8', start, end), next: end }
}

function writeExternalId(chunks: Buffer[], id: unknown): void {
  if (id === undefined) {
    chunks.push(Buffer.from([ID_TAG_EMPTY]))
    return
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    const header = Buffer.alloc(1 + 8)
    header.writeUInt8(ID_TAG_NUMBER, 0)
    header.writeDoubleLE(id, 1)
    chunks.push(header)
    return
  }
  if (typeof id === 'string') {
    const tag = Buffer.from([ID_TAG_STRING])
    chunks.push(tag)
    writeLengthPrefixedUtf8(chunks, id)
    return
  }
  const json = JSON.stringify(id)
  const tag = Buffer.from([ID_TAG_JSON])
  chunks.push(tag)
  writeLengthPrefixedUtf8(chunks, json)
}

function readExternalId(buf: Buffer, offset: number): { value: unknown | undefined, next: number } {
  if (offset >= buf.length) {
    throw invalidFrozenIndex('external id tag truncated')
  }
  const tag = buf.readUInt8(offset)
  if (tag === ID_TAG_EMPTY) {
    return { value: undefined, next: offset + 1 }
  }
  if (tag === ID_TAG_NUMBER) {
    if (offset + 9 > buf.length) {
      throw invalidFrozenIndex('external id number truncated')
    }
    return { value: buf.readDoubleLE(offset + 1), next: offset + 9 }
  }
  if (tag === ID_TAG_STRING) {
    const { value, next } = readLengthPrefixedUtf8(buf, offset + 1)
    return { value, next }
  }
  if (tag === ID_TAG_JSON) {
    const { value, next } = readLengthPrefixedUtf8(buf, offset + 1)
    return { value: JSON.parse(value), next }
  }
  throw invalidFrozenIndex(`unknown external id tag ${tag}`)
}

function buildCoreSection(snap: FrozenSnapshot): Buffer {
  const out = Buffer.alloc(12)
  out.writeUInt32LE(snap.documentCount, 0)
  out.writeUInt32LE(snap.nextId, 4)
  out.writeUInt32LE(snap.fieldCount, 8)
  return out
}

function buildFieldNamesSection(fieldNames: string[]): Buffer {
  const chunks: Buffer[] = []
  for (const name of fieldNames) {
    writeLengthPrefixedUtf8(chunks, name)
  }
  return Buffer.concat(chunks)
}

function buildExternalIdsSection(externalIds: unknown[], nextId: number): Buffer {
  const chunks: Buffer[] = []
  for (let i = 0; i < nextId; i++) {
    writeExternalId(chunks, externalIds[i])
  }
  return Buffer.concat(chunks)
}

function buildStoredFieldsSection(
  storedFields: (Record<string, unknown> | undefined)[],
  nextId: number,
): Buffer {
  const table = Buffer.alloc(nextId * 4)
  const heapChunks: Buffer[] = []
  let heapOff = 0
  for (let i = 0; i < nextId; i++) {
    const row = storedFields[i]
    if (row == null) {
      table.writeUInt32LE(0, i * 4)
      continue
    }
    table.writeUInt32LE(heapOff + 1, i * 4)
    const json = Buffer.from(JSON.stringify(row), 'utf8')
    const entry = Buffer.alloc(4 + json.length)
    entry.writeUInt32LE(json.length, 0)
    json.copy(entry, 4)
    heapChunks.push(entry)
    heapOff += entry.length
  }
  return Buffer.concat([table, ...heapChunks])
}

function writeTermTreeNode(chunks: Buffer[], tree: RadixTree<number>): void {
  const entries: Array<[string, number | RadixTree<number>]> = []
  for (const [key, val] of tree) {
    entries.push([key, val as number | RadixTree<number>])
  }

  const countBuf = Buffer.alloc(2)
  countBuf.writeUInt16LE(entries.length, 0)
  chunks.push(countBuf)

  for (const [key, val] of entries) {
    if (key === LEAF) {
      const node = Buffer.alloc(1 + 4)
      node.writeUInt8(TREE_NODE_LEAF, 0)
      node.writeUInt32LE(val as number, 1)
      chunks.push(node)
    } else {
      const keyBuf = Buffer.from(key, 'utf8')
      if (keyBuf.length > 0xffff) {
        throw invalidFrozenIndex('term tree edge key too long')
      }
      const header = Buffer.alloc(1 + 2 + keyBuf.length)
      header.writeUInt8(TREE_NODE_EDGE, 0)
      header.writeUInt16LE(keyBuf.length, 1)
      keyBuf.copy(header, 3)
      chunks.push(header)
      writeTermTreeNode(chunks, val as RadixTree<number>)
    }
  }
}

function buildTermTreeSection(tree: RadixTree<number>): Buffer {
  const chunks: Buffer[] = []
  writeTermTreeNode(chunks, tree)
  return Buffer.concat(chunks)
}

function readTermTreeNode(buf: Buffer, offset: number, end: number): { tree: RadixTree<number>, next: number } {
  if (offset + 2 > end) {
    throw invalidFrozenIndex('term tree node child count truncated')
  }
  const childCount = buf.readUInt16LE(offset)
  const tree = new Map() as RadixTree<number>
  let o = offset + 2

  for (let c = 0; c < childCount; c++) {
    if (o >= end) {
      throw invalidFrozenIndex('term tree child truncated')
    }
    const tag = buf.readUInt8(o)
    if (tag === TREE_NODE_LEAF) {
      if (o + 5 > end) {
        throw invalidFrozenIndex('term tree leaf truncated')
      }
      tree.set(LEAF, buf.readUInt32LE(o + 1))
      o += 5
      continue
    }
    if (tag === TREE_NODE_EDGE) {
      if (o + 3 > end) {
        throw invalidFrozenIndex('term tree edge header truncated')
      }
      const keyLen = buf.readUInt16LE(o + 1)
      const keyStart = o + 3
      const keyEnd = keyStart + keyLen
      if (keyEnd > end) {
        throw invalidFrozenIndex('term tree edge key out of bounds')
      }
      const key = buf.toString('utf8', keyStart, keyEnd)
      const { tree: child, next } = readTermTreeNode(buf, keyEnd, end)
      tree.set(key, child)
      o = next
      continue
    }
    throw invalidFrozenIndex(`unknown term tree node tag ${tag}`)
  }

  return { tree, next: o }
}

function readTermTreeSection(buf: Buffer, offset: number, end: number): RadixTree<number> {
  const { tree, next } = readTermTreeNode(buf, offset, end)
  if (next !== end) {
    throw invalidFrozenIndex('term tree section has trailing bytes')
  }
  return tree
}

function buildDictionarySection(terms: string[]): Buffer {
  const termBufs = terms.map(term => Buffer.from(term, 'utf8'))
  const dictHeaderLen = 4 + terms.length * 4
  const dictBodyLen = termBufs.reduce((sum, b) => sum + b.length, 0)
  const out = Buffer.alloc(dictHeaderLen + dictBodyLen)
  out.writeUInt32LE(terms.length, 0)
  for (let i = 0; i < termBufs.length; i++) {
    out.writeUInt32LE(termBufs[i].length, 4 + i * 4)
  }
  let bodyOff = dictHeaderLen
  for (const termBuf of termBufs) {
    termBuf.copy(out, bodyOff)
    bodyOff += termBuf.length
  }
  return out
}

function readDictionarySection(buf: Buffer, offset: number, end: number): string[] {
  if (offset + 4 > end) {
    throw invalidFrozenIndex('dictionary section truncated')
  }
  const termCount = buf.readUInt32LE(offset)
  const dictLengthsOff = offset + 4
  const dictBodyOff = dictLengthsOff + termCount * 4
  if (dictBodyOff > end) {
    throw invalidFrozenIndex('dictionary length table out of bounds')
  }
  const terms: string[] = []
  let o = dictBodyOff
  for (let i = 0; i < termCount; i++) {
    const lenOff = dictLengthsOff + i * 4
    if (lenOff + 4 > end) {
      throw invalidFrozenIndex('dictionary length entry out of bounds')
    }
    const len = buf.readUInt32LE(lenOff)
    if (o + len > end) {
      throw invalidFrozenIndex('dictionary term bytes out of bounds')
    }
    terms.push(buf.toString('utf8', o, o + len))
    o += len
  }
  if (o !== end) {
    throw invalidFrozenIndex('dictionary section has trailing bytes')
  }
  return terms
}

export function encodeFrozenSnapshot(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
): Buffer {
  validateFrozenSnapshotNumeric(snap)
  const tree = termTree ?? deserializeTermIndexTree(snap.treeShape)
  validateTermTreeLeaves(tree, snap.terms.length)

  const fieldNames = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
  if (fieldNames.length !== snap.fieldCount) {
    throw invalidFrozenIndex('fieldNames length mismatch')
  }

  const coreBuf = buildCoreSection(snap)
  const fieldNamesBuf = buildFieldNamesSection(fieldNames)
  const externalIdsBuf = buildExternalIdsSection(snap.externalIds, snap.nextId)
  const storedFieldsBuf = buildStoredFieldsSection(snap.storedFields, snap.nextId)
  const termTreeBuf = buildTermTreeSection(tree)
  const dictBuf = buildDictionarySection(snap.terms)

  const sectionSizes = [
    coreBuf.length,
    fieldNamesBuf.length,
    externalIdsBuf.length,
    storedFieldsBuf.length,
    termTreeBuf.length,
    snap.avgFieldLength.byteLength,
    snap.fieldLengthMatrix.byteLength,
    dictBuf.length,
    snap.postingsOffsets.byteLength,
    snap.postingsLengths.byteLength,
    snap.allDocIds.byteLength,
    snap.allFreqs.byteLength,
  ]

  const totalSize = HEADER_SIZE_V3 + sectionSizes.reduce((a, b) => a + b, 0)
  const out = Buffer.alloc(totalSize)

  out.write(BINARY_MAGIC_V3, 0, 4, 'ascii')
  out.writeUInt16LE(BINARY_VERSION_V3, 4)
  out.writeUInt16LE(0, 6)
  out.writeUInt32LE(0, 8)

  let sectionOff = HEADER_SIZE_V3
  for (let i = 0; i < sectionSizes.length; i++) {
    out.writeUInt32LE(sectionOff, 12 + i * 4)
    sectionOff += sectionSizes[i]
  }
  out.writeUInt32LE(sectionOff, 12 + sectionSizes.length * 4)

  let off = HEADER_SIZE_V3
  coreBuf.copy(out, off); off += coreBuf.length
  fieldNamesBuf.copy(out, off); off += fieldNamesBuf.length
  externalIdsBuf.copy(out, off); off += externalIdsBuf.length
  storedFieldsBuf.copy(out, off); off += storedFieldsBuf.length
  termTreeBuf.copy(out, off); off += termTreeBuf.length
  writeView(out, off, snap.avgFieldLength); off += snap.avgFieldLength.byteLength
  writeView(out, off, snap.fieldLengthMatrix); off += snap.fieldLengthMatrix.byteLength
  dictBuf.copy(out, off); off += dictBuf.length
  writeView(out, off, snap.postingsOffsets); off += snap.postingsOffsets.byteLength
  writeView(out, off, snap.postingsLengths); off += snap.postingsLengths.byteLength
  writeView(out, off, snap.allDocIds); off += snap.allDocIds.byteLength
  writeView(out, off, snap.allFreqs)

  const crc = crc32Buffer(out, HEADER_SIZE_V3, out.length)
  out.writeUInt32LE(crc, 8)

  return out
}

function validateTermTreeLeaves(tree: RadixTree<number>, termCount: number): void {
  for (const [key, val] of tree) {
    if (key === LEAF) {
      const idx = val as number
      if (!Number.isInteger(idx) || idx < 0 || idx >= termCount) {
        throw invalidFrozenIndex(`term tree leaf index out of range: ${idx}`)
      }
    } else {
      validateTermTreeLeaves(val as RadixTree<number>, termCount)
    }
  }
}

function decodeMSv3(buf: Buffer): FrozenSnapshot {
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
  const dictOff = buf.readUInt32LE(40)
  const postOffOff = buf.readUInt32LE(44)
  const postLenOff = buf.readUInt32LE(48)
  const docIdsOff = buf.readUInt32LE(52)
  const freqsOff = buf.readUInt32LE(56)
  const endOff = buf.readUInt32LE(60)

  const sectionOffsets = [
    coreOff, fieldNamesOff, externalIdsOff, storedOff, treeOff,
    avgOff, flOff, dictOff, postOffOff, postLenOff, docIdsOff, freqsOff, endOff,
  ]
  assertSectionOffsets(buf, HEADER_SIZE_V3, sectionOffsets)

  if (coreOff + 12 > fieldNamesOff) {
    throw invalidFrozenIndex('core section size mismatch')
  }
  const documentCount = buf.readUInt32LE(coreOff)
  const nextId = buf.readUInt32LE(coreOff + 4)
  const fieldCount = buf.readUInt32LE(coreOff + 8)

  const fieldNames: string[] = []
  let o = fieldNamesOff
  for (let f = 0; f < fieldCount; f++) {
    const { value, next } = readLengthPrefixedUtf8(buf, o)
    fieldNames.push(value)
    o = next
  }
  if (o !== externalIdsOff) {
    throw invalidFrozenIndex('field names section size mismatch')
  }

  const fieldIds: { [field: string]: number } = {}
  for (let f = 0; f < fieldNames.length; f++) {
    fieldIds[fieldNames[f]] = f
  }

  const externalIds: unknown[] = new Array(nextId)
  o = externalIdsOff
  for (let i = 0; i < nextId; i++) {
    const { value, next } = readExternalId(buf, o)
    externalIds[i] = value
    o = next
  }
  if (o !== storedOff) {
    throw invalidFrozenIndex('external ids section size mismatch')
  }

  const storedFields: (Record<string, unknown> | undefined)[] = new Array(nextId)
  const tableEnd = storedOff + nextId * 4
  if (tableEnd > treeOff) {
    throw invalidFrozenIndex('stored fields table out of bounds')
  }
  for (let i = 0; i < nextId; i++) {
    const rel = buf.readUInt32LE(storedOff + i * 4)
    if (rel === 0) {
      storedFields[i] = undefined
      continue
    }
    const entryOff = tableEnd + rel - 1
    if (entryOff + 4 > treeOff) {
      throw invalidFrozenIndex('stored fields entry offset out of bounds')
    }
    const jsonLen = buf.readUInt32LE(entryOff)
    const jsonStart = entryOff + 4
    const jsonEnd = jsonStart + jsonLen
    if (jsonEnd > treeOff) {
      throw invalidFrozenIndex('stored fields JSON out of bounds')
    }
    storedFields[i] = JSON.parse(buf.toString('utf8', jsonStart, jsonEnd)) as Record<string, unknown>
  }

  const termTree = readTermTreeSection(buf, treeOff, avgOff)
  const treeShape = serializeTermIndexTree(termTree)

  const avgFieldLength = readFloat32Array(buf, avgOff, flOff - avgOff)
  const fieldLengthMatrix = readUint32Array(buf, flOff, dictOff - flOff)

  const terms = readDictionarySection(buf, dictOff, postOffOff)

  const slotCount = terms.length * fieldCount
  if ((postLenOff - postOffOff) !== slotCount * 4 || (docIdsOff - postLenOff) !== slotCount * 4) {
    throw invalidFrozenIndex('postings section size mismatch')
  }

  const postingsOffsets = readUint32Array(buf, postOffOff, slotCount * 4)
  const postingsLengths = readUint32Array(buf, postLenOff, slotCount * 4)
  const allDocIds = readUint32Array(buf, docIdsOff, freqsOff - docIdsOff)
  const allFreqs = readUint8Array(buf, freqsOff, endOff - freqsOff)

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
    terms,
    treeShape,
    termTree,
    postingsOffsets,
    postingsLengths,
    allDocIds,
    allFreqs,
  }

  validateFrozenSnapshot(snap)
  return snap
}

export function decodeFrozenSnapshot(buf: Buffer): FrozenSnapshot {
  assertBufferLength(buf, 8)
  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)

  if (magic === BINARY_MAGIC_V3 && version === BINARY_VERSION_V3) {
    return decodeMSv3(buf)
  }
  if (magic === 'MSv1' || magic === 'MSv2') {
    throw invalidFrozenIndex(
      `${magic} is no longer supported; re-save with MSv3 (minisearch 8.0.0+)`,
    )
  }
  throw invalidFrozenIndex(`magic=${magic} version=${version}`)
}

export function deserializeTermIndexTree(shape: TreeShape): RadixTree<number> {
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

export function serializeTermIndexTree(tree: RadixTree<number>): TreeShape {
  const shape: TreeShape = []
  const entries: Array<[string, number | RadixTree<number>]> = []
  for (const [key, val] of tree) {
    entries.push([key, val as number | RadixTree<number>])
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  for (const [key, val] of entries) {
    if (key === LEAF) {
      shape.push([key, val as number])
    } else {
      shape.push([key, serializeTermIndexTree(val as RadixTree<number>)])
    }
  }
  return shape
}
