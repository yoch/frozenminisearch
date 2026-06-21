import zlib from 'node:zlib'
import type { FieldIdArray } from './frozenPostings'
import {
  ID_TAG_EMPTY,
  ID_TAG_JSON,
  ID_TAG_NUMBER,
  ID_TAG_STRING,
} from './binaryConstants'
import { crc32Update as crc32UpdateWire } from './crc32Wire'
import { invalidFrozenIndex } from './frozenErrors'

export { invalidFrozenIndex } from './frozenErrors'

// Default import (not `{ crc32 }`): `zlib.crc32` landed in Node 22.2.0 / 20.15.0. A named ESM
// import would throw at module load on older runtimes; property access is safe and lets
// `crc32Update` fall back to the pure-JS table below.
const zlibCrc32: typeof zlib.crc32 | undefined
  = typeof zlib.crc32 === 'function' ? zlib.crc32 : undefined

export function assertBufferLength(buf: Buffer, min: number): void {
  if (buf.length < min) {
    throw invalidFrozenIndex(`buffer too short (${buf.length} < ${min})`)
  }
}

export function assertSectionOffsets(buf: Buffer, headerSize: number, offsets: number[]): void {
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] < headerSize || offsets[i] > buf.length) {
      throw invalidFrozenIndex(`section offset ${i} out of bounds`)
    }
    if (i > 0 && offsets[i] < offsets[i - 1]) {
      throw invalidFrozenIndex('section offsets not monotonic')
    }
  }
}

/** Incremental CRC-32 IEEE update; pass the previous return value as `seed`. */
export function crc32Update(seed: number, buf: Buffer, start = 0, end = buf.length): number {
  if (typeof zlibCrc32 === 'function') {
    const slice = start === 0 && end === buf.length ? buf : buf.subarray(start, end)
    return zlibCrc32(slice, seed) >>> 0
  }
  return crc32UpdateWire(seed, buf, start, end)
}

/** CRC-32 IEEE (zlib polynomial); uses `zlib.crc32` when available. */
export function crc32Buffer(buf: Buffer, start = 0, end = buf.length): number {
  return crc32Update(0, buf, start, end)
}

export function readUint32Array(buf: Buffer, offset: number, byteLength: number): Uint32Array {
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

export function readUint16Array(buf: Buffer, offset: number, byteLength: number): Uint16Array {
  if (byteLength === 0) return new Uint16Array(0)
  if (byteLength % 2 !== 0) {
    throw invalidFrozenIndex('uint16 section length not aligned')
  }
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint16 section read past buffer end')
  }
  if (offset % 2 === 0) {
    return new Uint16Array(buf.buffer, buf.byteOffset + offset, byteLength / 2)
  }
  const out = new Uint16Array(byteLength / 2)
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt16LE(offset + i * 2)
  return out
}

export function readUint8Array(buf: Buffer, offset: number, byteLength: number): Uint8Array {
  if (byteLength === 0) return new Uint8Array(0)
  if (offset + byteLength > buf.length) {
    throw invalidFrozenIndex('uint8 section read past buffer end')
  }
  return new Uint8Array(buf.buffer, buf.byteOffset + offset, byteLength)
}

export function readFloat32Array(buf: Buffer, offset: number, byteLength: number): Float32Array {
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

export function bufferFromView(view: ArrayBufferView): Buffer {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

export function readFieldIdArray(buf: Buffer, offset: number, byteLength: number, width: 8 | 16): FieldIdArray {
  if (width === 8) return readUint8Array(buf, offset, byteLength)
  return readUint16Array(buf, offset, byteLength)
}

function writeLengthPrefixedUtf8(chunks: Buffer[], str: string): void {
  const body = Buffer.from(str, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  chunks.push(header, body)
}

export function readLengthPrefixedUtf8(buf: Buffer, offset: number): { value: string, next: number } {
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

export function writeExternalId(chunks: Buffer[], id: unknown): void {
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

export function readExternalId(buf: Buffer, offset: number): { value: unknown | undefined, next: number } {
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
