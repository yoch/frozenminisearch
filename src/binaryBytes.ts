/** Portable wire bytes (browser + Node). Node `Buffer` is accepted wherever `BinaryBytes` is expected. */
export type BinaryBytes = Uint8Array

export function allocBytes(length: number): Uint8Array {
  return new Uint8Array(length)
}

export function bytesFromView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

export function utf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
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

export function readFloatLE(buf: BinaryBytes, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat32(offset, true)
}

export function readDoubleLE(buf: BinaryBytes, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(offset, true)
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
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setFloat32(offset, value, true)
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
  return new TextDecoder().decode(buf.subarray(start, end))
}
