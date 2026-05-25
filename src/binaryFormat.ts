import { LEAF } from './SearchableMap/TreeIterator'
import type { RadixTree } from './SearchableMap/types'

export const BINARY_MAGIC_V1 = 'MSv1'
export const BINARY_VERSION_V1 = 1
export const BINARY_MAGIC_V2 = 'MSv2'
export const BINARY_VERSION_V2 = 2

const HEADER_SIZE_V2 = 48
const FREQ_UINT8 = 0
const FREQ_UINT16 = 1

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
function copyView (view: ArrayBufferView): Buffer {
  return Buffer.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
}

function alignedSlice (buf: Buffer, offset: number, length: number, alignment: number): Buffer {
  if (length === 0) return Buffer.alloc(0)
  if (offset % alignment === 0) {
    return buf.subarray(offset, offset + length)
  }
  return buf.subarray(offset, offset + length)
}

function readUint32Array (buf: Buffer, offset: number, byteLength: number): Uint32Array {
  if (byteLength === 0) return new Uint32Array(0)
  const slice = alignedSlice(buf, offset, byteLength, 4)
  if (slice.byteOffset % 4 === 0 && slice.length === byteLength) {
    return new Uint32Array(slice.buffer, slice.byteOffset, byteLength / 4)
  }
  const out = new Uint32Array(byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(offset + i * 4)
  return out
}

function readUint8Array (buf: Buffer, offset: number, byteLength: number): Uint8Array {
  if (byteLength === 0) return new Uint8Array(0)
  const slice = alignedSlice(buf, offset, byteLength, 1)
  return new Uint8Array(slice.buffer, slice.byteOffset, byteLength)
}

function readFloat32Array (buf: Buffer, offset: number, byteLength: number): Float32Array {
  if (byteLength === 0) return new Float32Array(0)
  const slice = alignedSlice(buf, offset, byteLength, 4)
  if (slice.byteOffset % 4 === 0 && slice.length === byteLength) {
    return new Float32Array(slice.buffer, slice.byteOffset, byteLength / 4)
  }
  const out = new Float32Array(byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(offset + i * 4)
  return out
}

export function encodeFrozenSnapshot (snap: FrozenSnapshot): Buffer {
  const metaJson = Buffer.from(JSON.stringify({
    documentCount: snap.documentCount,
    nextId: snap.nextId,
    fieldCount: snap.fieldCount,
    fieldIds: snap.fieldIds,
    externalIds: snap.externalIds,
    storedFields: snap.storedFields,
    treeShape: snap.treeShape
  }), 'utf8')

  const avgBuf = copyView(snap.avgFieldLength)
  const flBuf = copyView(snap.fieldLengthMatrix)

  const termBufs = snap.terms.map((term) => Buffer.from(term, 'utf8'))
  const dictHeader = Buffer.alloc(4 + snap.terms.length * 4)
  dictHeader.writeUInt32LE(snap.terms.length, 0)
  for (let i = 0; i < termBufs.length; i++) {
    dictHeader.writeUInt32LE(termBufs[i].length, 4 + i * 4)
  }
  const dict = Buffer.concat([dictHeader, ...termBufs])

  const offBuf = copyView(snap.postingsOffsets)
  const lenBuf = copyView(snap.postingsLengths)
  const docBuf = copyView(snap.allDocIds)
  const freqBuf = copyView(snap.allFreqs)

  const sections = [metaJson, avgBuf, flBuf, dict, offBuf, lenBuf, docBuf, freqBuf]
  const header = Buffer.alloc(HEADER_SIZE_V2)
  header.write(BINARY_MAGIC_V2, 0, 4, 'ascii')
  header.writeUInt16LE(BINARY_VERSION_V2, 4)
  header.writeUInt16LE(0, 6)

  let off = HEADER_SIZE_V2
  for (let i = 0; i < sections.length; i++) {
    header.writeUInt32LE(off, 8 + i * 4)
    off += sections[i].length
  }
  header.writeUInt32LE(off, 8 + sections.length * 4)

  return Buffer.concat([header, ...sections])
}

function decodeMSv2 (buf: Buffer): FrozenSnapshot {
  const metaOff = buf.readUInt32LE(8)
  const avgOff = buf.readUInt32LE(12)
  const flOff = buf.readUInt32LE(16)
  const dictOff = buf.readUInt32LE(20)
  const postOffOff = buf.readUInt32LE(24)
  const postLenOff = buf.readUInt32LE(28)
  const docIdsOff = buf.readUInt32LE(32)
  const freqsOff = buf.readUInt32LE(36)
  const endOff = buf.readUInt32LE(40)

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

  const termCount = buf.readUInt32LE(dictOff)
  const terms: string[] = []
  let o = dictOff + 4 + termCount * 4
  for (let i = 0; i < termCount; i++) {
    const len = buf.readUInt32LE(dictOff + 4 + i * 4)
    terms.push(buf.toString('utf8', o, o + len))
    o += len
  }

  const slotCount = termCount * meta.fieldCount
  const postingsOffsets = readUint32Array(buf, postOffOff, slotCount * 4)
  const postingsLengths = readUint32Array(buf, postLenOff, slotCount * 4)
  const allDocIds = readUint32Array(buf, docIdsOff, freqsOff - docIdsOff)
  const allFreqs = readUint8Array(buf, freqsOff, endOff - freqsOff)

  return {
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
}

function decodeMSv1 (buf: Buffer): FrozenSnapshot {
  const metaOff = buf.readUInt32LE(8)
  const avgOff = buf.readUInt32LE(12)
  const flOff = buf.readUInt32LE(16)
  const dictOff = buf.readUInt32LE(20)
  const postOff = buf.readUInt32LE(24)

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

  const termCount = buf.readUInt32LE(dictOff)
  const terms: string[] = []
  let o = dictOff + 4 + termCount * 4
  for (let i = 0; i < termCount; i++) {
    const len = buf.readUInt32LE(dictOff + 4 + i * 4)
    terms.push(buf.toString('utf8', o, o + len))
    o += len
  }

  const fieldCount = meta.fieldCount
  const slotCount = termCount * fieldCount
  const postingsOffsets = new Uint32Array(slotCount)
  const postingsLengths = new Uint32Array(slotCount)
  const docIdChunks: number[] = []
  const freqChunks: number[] = []

  o = postOff
  for (let ti = 0; ti < termCount; ti++) {
    const fc = buf.readUInt16LE(o); o += 2
    const base = ti * fieldCount

    for (let f = 0; f < fc; f++) {
      buf.readUInt32LE(o); o += 4 // matchCount — same as docLen
      const docLen = buf.readUInt32LE(o); o += 4
      postingsLengths[base + f] = docLen

      if (docLen === 0) {
        postingsOffsets[base + f] = 0
        o += 1
        continue
      }

      postingsOffsets[base + f] = docIdChunks.length
      const kind = buf.readUInt8(o); o += 1

      for (let d = 0; d < docLen; d++) {
        docIdChunks.push(buf.readUInt32LE(o + d * 4))
      }
      o += docLen * 4

      const freqElem = kind === FREQ_UINT8 ? 1 : kind === FREQ_UINT16 ? 2 : 4
      for (let d = 0; d < docLen; d++) {
        let freq: number
        if (kind === FREQ_UINT8) freq = buf.readUInt8(o + d)
        else if (kind === FREQ_UINT16) freq = buf.readUInt16LE(o + d * 2)
        else freq = buf.readUInt32LE(o + d * 4)
        freqChunks.push(freq > 255 ? 255 : freq)
      }
      o += docLen * freqElem
    }
  }

  return {
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
}

export function decodeFrozenSnapshot (buf: Buffer): FrozenSnapshot {
  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)

  if (magic === BINARY_MAGIC_V2 && version === BINARY_VERSION_V2) {
    return decodeMSv2(buf)
  }
  if (magic === BINARY_MAGIC_V1 && version === BINARY_VERSION_V1) {
    return decodeMSv1(buf)
  }
  throw new Error(`Invalid frozen index: magic=${magic} version=${version}`)
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
