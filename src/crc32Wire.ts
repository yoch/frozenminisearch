import type { BinaryBytes } from './binaryBytes'

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[i] = c
}

/** Incremental CRC-32 IEEE update; pass the previous return value as `seed`. */
export function crc32Update(seed: number, buf: BinaryBytes, start = 0, end = buf.length): number {
  let crc = (seed ^ 0xffffffff) >>> 0
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** CRC-32 IEEE (zlib polynomial). */
export function crc32Bytes(buf: BinaryBytes, start = 0, end = buf.length): number {
  return crc32Update(0, buf, start, end)
}
