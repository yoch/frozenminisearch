import zlib from 'node:zlib'
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
