import type { BinaryBytes } from './binaryBytes'

/**
 * Slicing-by-8 tables, flattened: `CRC_TABLES[k * 256 + b]` is the CRC of byte `b`
 * followed by `k` zero bytes, so eight input bytes fold into the state per step.
 */
const CRC_TABLES = new Uint32Array(8 * 256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLES[i] = c
}
for (let k = 1; k < 8; k++) {
  for (let i = 0; i < 256; i++) {
    const previous = CRC_TABLES[(k - 1) * 256 + i]
    CRC_TABLES[k * 256 + i] = (previous >>> 8) ^ CRC_TABLES[previous & 0xff]
  }
}

/** Incremental CRC-32 IEEE update; pass the previous return value as `seed`. */
export function crc32Update(
  seed: number,
  buf: BinaryBytes,
  start = 0,
  end = buf.length,
): number {
  const t = CRC_TABLES
  let crc = ~seed
  let i = start
  for (const last = end - 8; i <= last; i += 8) {
    const low =
      crc ^
      (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24))
    crc =
      t[1792 + (low & 0xff)] ^
      t[1536 + ((low >>> 8) & 0xff)] ^
      t[1280 + ((low >>> 16) & 0xff)] ^
      t[1024 + (low >>> 24)] ^
      t[768 + buf[i + 4]] ^
      t[512 + buf[i + 5]] ^
      t[256 + buf[i + 6]] ^
      t[buf[i + 7]]
  }
  for (; i < end; i++) {
    crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xff]
  }
  return ~crc >>> 0
}

/** CRC-32 IEEE (zlib polynomial). */
export function crc32Bytes(
  buf: BinaryBytes,
  start = 0,
  end = buf.length,
): number {
  return crc32Update(0, buf, start, end)
}
