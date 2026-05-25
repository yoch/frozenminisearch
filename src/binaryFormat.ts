import { CompactPostingList } from './compactPostings'
import type { CompactFieldTermData } from './compactPostings'

export const BINARY_MAGIC = 'MSv1'
export const BINARY_VERSION = 1

const FREQ_UINT8 = 0
const FREQ_UINT16 = 1
const FREQ_UINT32 = 2

export type TreeShape = Array<[string, number | TreeShape]>

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
  postingsByTerm: CompactFieldTermData[]
  treeShape: TreeShape
}

function freqKind (arr: Uint8Array | Uint16Array | Uint32Array): number {
  if (arr instanceof Uint8Array) return FREQ_UINT8
  if (arr instanceof Uint16Array) return FREQ_UINT16
  return FREQ_UINT32
}

function copyView (view: ArrayBufferView): Buffer {
  return Buffer.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
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

  const postParts: Buffer[] = []
  for (const pdata of snap.postingsByTerm) {
    const part = Buffer.alloc(2)
    part.writeUInt16LE(snap.fieldCount, 0)
    postParts.push(part)

    for (let f = 0; f < snap.fieldCount; f++) {
      const list = pdata.byField[f]
      const matchCount = pdata.matchingFieldsByField[f] ?? 0

      if (list == null || list.docIds.length === 0) {
        postParts.push(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0]))
        continue
      }

      const docBuf = copyView(list.docIds)
      const freqBuf = copyView(list.freqs)
      const chunk = Buffer.alloc(4 + 4 + 1 + docBuf.length + freqBuf.length)
      let o = 0
      chunk.writeUInt32LE(matchCount, o); o += 4
      chunk.writeUInt32LE(list.docIds.length, o); o += 4
      chunk.writeUInt8(freqKind(list.freqs), o); o += 1
      docBuf.copy(chunk, o); o += docBuf.length
      freqBuf.copy(chunk, o)
      postParts.push(chunk)
    }
  }

  const postings = Buffer.concat(postParts)
  const sections = [metaJson, avgBuf, flBuf, dict, postings]
  const header = Buffer.alloc(32)
  header.write(BINARY_MAGIC, 0, 4, 'ascii')
  header.writeUInt16LE(BINARY_VERSION, 4)
  header.writeUInt16LE(0, 6)

  let off = 32
  for (let i = 0; i < sections.length; i++) {
    header.writeUInt32LE(off, 8 + i * 4)
    off += sections[i].length
  }
  header.writeUInt32LE(off, 8 + sections.length * 4)

  return Buffer.concat([header, ...sections])
}

export function decodeFrozenSnapshot (buf: Buffer): FrozenSnapshot {
  if (buf.toString('ascii', 0, 4) !== BINARY_MAGIC) {
    throw new Error('Invalid frozen index: bad magic')
  }

  const version = buf.readUInt16LE(4)
  if (version !== BINARY_VERSION) {
    throw new Error(`Unsupported frozen index version: ${version}`)
  }

  const metaOff = buf.readUInt32LE(8)
  const avgOff = buf.readUInt32LE(12)
  const flOff = buf.readUInt32LE(16)
  const dictOff = buf.readUInt32LE(20)
  const postOff = buf.readUInt32LE(24)

  const meta = JSON.parse(buf.toString('utf8', metaOff, avgOff)) as {
    documentCount: number
    nextId: number
    fieldCount: number
    fieldIds: { [key: string]: number }
    externalIds: unknown[]
    storedFields: (Record<string, unknown> | undefined)[]
    treeShape: TreeShape
  }

  const avgBytes = flOff - avgOff
  const avgFieldLength = new Float32Array(avgBytes / 4)
  for (let i = 0; i < avgFieldLength.length; i++) {
    avgFieldLength[i] = buf.readFloatLE(avgOff + i * 4)
  }

  const flBytes = dictOff - flOff
  const fieldLengthMatrix = new Uint32Array(flBytes / 4)
  for (let i = 0; i < fieldLengthMatrix.length; i++) {
    fieldLengthMatrix[i] = buf.readUInt32LE(flOff + i * 4)
  }

  const termCount = buf.readUInt32LE(dictOff)
  const terms: string[] = []
  let o = dictOff + 4 + termCount * 4

  for (let i = 0; i < termCount; i++) {
    const len = buf.readUInt32LE(dictOff + 4 + i * 4)
    terms.push(buf.toString('utf8', o, o + len))
    o += len
  }

  const postingsByTerm: CompactFieldTermData[] = []
  o = postOff

  for (let ti = 0; ti < termCount; ti++) {
    const fieldCount = buf.readUInt16LE(o); o += 2
    const byField: (CompactPostingList | undefined)[] = new Array(fieldCount)
    const matchingFieldsByField = new Uint32Array(fieldCount)

    for (let f = 0; f < fieldCount; f++) {
      const matchCount = buf.readUInt32LE(o); o += 4
      const docLen = buf.readUInt32LE(o); o += 4
      matchingFieldsByField[f] = matchCount

      if (docLen === 0) {
        o += 1
        continue
      }

      const kind = buf.readUInt8(o); o += 1
      const docBytes = docLen * 4
      const docIds = new Uint32Array(docLen)
      for (let d = 0; d < docLen; d++) {
        docIds[d] = buf.readUInt32LE(o + d * 4)
      }
      o += docBytes

      const freqElem = kind === FREQ_UINT8 ? 1 : kind === FREQ_UINT16 ? 2 : 4
      const freqBytes = docLen * freqElem
      let freqs: Uint8Array | Uint16Array | Uint32Array

      if (kind === FREQ_UINT8) {
        freqs = new Uint8Array(docLen)
        for (let d = 0; d < docLen; d++) freqs[d] = buf.readUInt8(o + d)
      } else if (kind === FREQ_UINT16) {
        freqs = new Uint16Array(docLen)
        for (let d = 0; d < docLen; d++) freqs[d] = buf.readUInt16LE(o + d * 2)
      } else {
        freqs = new Uint32Array(docLen)
        for (let d = 0; d < docLen; d++) freqs[d] = buf.readUInt32LE(o + d * 4)
      }

      o += freqBytes
      byField[f] = new CompactPostingList(docIds, freqs)
    }

    postingsByTerm.push({ byField, matchingFieldsByField })
  }

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
    postingsByTerm,
    treeShape: meta.treeShape
  }
}
