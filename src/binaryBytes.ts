/** Portable wire bytes (browser + Node). Node `Buffer` is accepted wherever `BinaryBytes` is expected. */
export type BinaryBytes = Uint8Array

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function allocBytes(length: number): Uint8Array {
  return new Uint8Array(length)
}

export function bytesFromView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

export function utf8Bytes(str: string): Uint8Array {
  return textEncoder.encode(str)
}

/** Concatenate byte chunks. Accepts an array to avoid spread stack limits on large corpora. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let off = 0
  for (const part of parts) {
    out.set(part, off)
    off += part.length
  }
  return out
}

export function readU8(buf: BinaryBytes, offset: number): number {
  return buf[offset]
}

export function readU16LE(buf: BinaryBytes, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8)
}

export function readU32LE(buf: BinaryBytes, offset: number): number {
  return (
    buf[offset]
    | (buf[offset + 1] << 8)
    | (buf[offset + 2] << 16)
    | (buf[offset + 3] << 24)
  ) >>> 0
}

// Decode floats through a fixed 8-byte scratch DataView. Hot loops (external id
// decode) would otherwise allocate a DataView per element, which dominates load
// time. A small fixed scratch avoids both per-call allocation and pinning the
// caller's backing ArrayBuffer, while keeping explicit little-endian semantics.
const floatScratch = new ArrayBuffer(8)
const floatScratchView = new DataView(floatScratch)
const floatScratchBytes = new Uint8Array(floatScratch)

export function readFloatLE(buf: BinaryBytes, offset: number): number {
  floatScratchBytes[0] = buf[offset]
  floatScratchBytes[1] = buf[offset + 1]
  floatScratchBytes[2] = buf[offset + 2]
  floatScratchBytes[3] = buf[offset + 3]
  return floatScratchView.getFloat32(0, true)
}

export function readDoubleLE(buf: BinaryBytes, offset: number): number {
  floatScratchBytes[0] = buf[offset]
  floatScratchBytes[1] = buf[offset + 1]
  floatScratchBytes[2] = buf[offset + 2]
  floatScratchBytes[3] = buf[offset + 3]
  floatScratchBytes[4] = buf[offset + 4]
  floatScratchBytes[5] = buf[offset + 5]
  floatScratchBytes[6] = buf[offset + 6]
  floatScratchBytes[7] = buf[offset + 7]
  return floatScratchView.getFloat64(0, true)
}

export function writeU8(buf: BinaryBytes, offset: number, value: number): void {
  buf[offset] = value & 0xff
}

export function writeU16LE(buf: BinaryBytes, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
}

export function writeU32LE(buf: BinaryBytes, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
  buf[offset + 3] = (value >>> 24) & 0xff
}

export function writeFloatLE(buf: BinaryBytes, offset: number, value: number): void {
  floatScratchView.setFloat32(0, value, true)
  buf[offset] = floatScratchBytes[0]
  buf[offset + 1] = floatScratchBytes[1]
  buf[offset + 2] = floatScratchBytes[2]
  buf[offset + 3] = floatScratchBytes[3]
}

export function writeDoubleLE(buf: BinaryBytes, offset: number, value: number): void {
  floatScratchView.setFloat64(0, value, true)
  buf[offset] = floatScratchBytes[0]
  buf[offset + 1] = floatScratchBytes[1]
  buf[offset + 2] = floatScratchBytes[2]
  buf[offset + 3] = floatScratchBytes[3]
  buf[offset + 4] = floatScratchBytes[4]
  buf[offset + 5] = floatScratchBytes[5]
  buf[offset + 6] = floatScratchBytes[6]
  buf[offset + 7] = floatScratchBytes[7]
}

export function writeAscii(buf: BinaryBytes, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i) & 0xff
  }
}

export function readAscii(buf: BinaryBytes, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(buf[offset + i])
  return out
}

export function readUtf8(buf: BinaryBytes, start: number, end: number): string {
  return textDecoder.decode(buf.subarray(start, end))
}
