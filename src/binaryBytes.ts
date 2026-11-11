/** Portable wire bytes (browser + Node). Node `Buffer` is accepted wherever `BinaryBytes` is expected. */
export type BinaryBytes = Uint8Array

const textEncoder = new TextEncoder()
// Strings are raw UTF-8 slices: a leading U+FEFF is data (a term, id or label), not a BOM.
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

export function allocBytes(length: number): Uint8Array {
  return new Uint8Array(length)
}

export function bytesFromView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

export function utf8Bytes(str: string): Uint8Array {
  return textEncoder.encode(str)
}

export function readU8(buf: BinaryBytes, offset: number): number {
  return buf[offset]
}

export function readU16LE(buf: BinaryBytes, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8)
}

export function readU32LE(buf: BinaryBytes, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  )
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

export function writeU16LE(
  buf: BinaryBytes,
  offset: number,
  value: number,
): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
}

export function writeU32LE(
  buf: BinaryBytes,
  offset: number,
  value: number,
): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
  buf[offset + 3] = (value >>> 24) & 0xff
}

export function writeFloatLE(
  buf: BinaryBytes,
  offset: number,
  value: number,
): void {
  floatScratchView.setFloat32(0, value, true)
  buf[offset] = floatScratchBytes[0]
  buf[offset + 1] = floatScratchBytes[1]
  buf[offset + 2] = floatScratchBytes[2]
  buf[offset + 3] = floatScratchBytes[3]
}

export function writeDoubleLE(
  buf: BinaryBytes,
  offset: number,
  value: number,
): void {
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

export function writeAscii(
  buf: BinaryBytes,
  offset: number,
  str: string,
): void {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i) & 0xff
  }
}

export function readAscii(
  buf: BinaryBytes,
  offset: number,
  length: number,
): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(buf[offset + i])
  return out
}

export function readUtf8(buf: BinaryBytes, start: number, end: number): string {
  return textDecoder.decode(buf.subarray(start, end))
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** False when `str` has an unpaired surrogate, which UTF-8 cannot represent. */
export function isWellFormedUtf16(str: string): boolean {
  return !LONE_SURROGATE.test(str)
}

export function utf16LeBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length * 2)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    out[i * 2] = code & 0xff
    out[i * 2 + 1] = code >>> 8
  }
  return out
}

const UTF16_DECODE_CHUNK = 0x2000

export function readUtf16LE(
  buf: BinaryBytes,
  start: number,
  end: number,
): string {
  const length = (end - start) >>> 1
  const codes = new Uint16Array(Math.min(length, UTF16_DECODE_CHUNK))
  let out = ''
  for (let i = 0; i < length; i += UTF16_DECODE_CHUNK) {
    const count = Math.min(UTF16_DECODE_CHUNK, length - i)
    for (let k = 0; k < count; k++) {
      const at = start + (i + k) * 2
      codes[k] = buf[at] | (buf[at + 1] << 8)
    }
    out += String.fromCharCode(...codes.subarray(0, count))
  }
  return out
}

const HOST_IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/**
 * Snapshot columns are little-endian on the wire and read through typed-array views,
 * which use the host byte order: saving or loading on a big-endian host would
 * silently swap every multi-byte value.
 */
export function assertLittleEndianHost(
  isLittleEndian = HOST_IS_LITTLE_ENDIAN,
): void {
  if (!isLittleEndian) {
    throw new Error(
      'FrozenMiniSearch: binary snapshots require a little-endian host',
    )
  }
}

/**
 * Bytes of a snapshot given as any buffer view or (Shared)ArrayBuffer, without copying.
 * Checks by tag rather than `instanceof`, so buffers from another realm are accepted.
 */
export function snapshotBytes(input: unknown): Uint8Array {
  if (ArrayBuffer.isView(input)) {
    return input instanceof Uint8Array
      ? input
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  const tag = Object.prototype.toString.call(input)
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
    return new Uint8Array(input as ArrayBuffer)
  }
  throw new TypeError(
    'FrozenMiniSearch: a binary snapshot must be a typed array or an ArrayBuffer',
  )
}

/** Longer strings are encoded apart, so the writer never over-reserves more than 3x this. */
const ENCODE_IN_PLACE_MAX_LENGTH = 16384

/**
 * Append-only byte sink for sections made of many small values (ids, stored rows):
 * one growing buffer instead of an allocation per value, and strings encoded in place.
 */
export class ByteWriter {
  private _buf: Uint8Array
  private _length = 0

  constructor(capacity = 256) {
    this._buf = new Uint8Array(Math.max(16, capacity))
  }

  get length(): number {
    return this._length
  }

  private reserve(extra: number): void {
    const needed = this._length + extra
    if (needed <= this._buf.length) return
    const grown = new Uint8Array(Math.max(needed, this._buf.length * 2))
    grown.set(this._buf.subarray(0, this._length))
    this._buf = grown
  }

  /** Append `count` zero bytes and return their offset, to fill in with {@link setU32}. */
  skip(count: number): number {
    this.reserve(count)
    // Bytes past `_length` are never written, so they are still zero.
    const offset = this._length
    this._length = offset + count
    return offset
  }

  u8(value: number): void {
    this.reserve(1)
    this._buf[this._length++] = value
  }

  setU32(offset: number, value: number): void {
    writeU32LE(this._buf, offset, value)
  }

  f64(value: number): void {
    this.reserve(8)
    writeDoubleLE(this._buf, this._length, value)
    this._length += 8
  }

  /** u32 byte length, then the string as UTF-8. Returns the UTF-8 byte length. */
  lengthPrefixedUtf8(str: string): number {
    if (str.length > ENCODE_IN_PLACE_MAX_LENGTH) {
      // Encoding in place reserves the worst case; a large string gets its exact size.
      const body = textEncoder.encode(str)
      this.reserve(4 + body.length)
      writeU32LE(this._buf, this._length, body.length)
      this._buf.set(body, this._length + 4)
      this._length += 4 + body.length
      return body.length
    }
    // A UTF-16 code unit takes at most 3 UTF-8 bytes.
    this.reserve(4 + str.length * 3)
    const start = this._length + 4
    const { written } = textEncoder.encodeInto(str, this._buf.subarray(start))
    writeU32LE(this._buf, this._length, written)
    this._length = start + written
    return written
  }

  /** The bytes written, in a buffer of their exact length. */
  finish(): Uint8Array {
    return this._buf.slice(0, this._length)
  }
}
