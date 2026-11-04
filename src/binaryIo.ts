import zlib from 'node:zlib'
import { crc32Update as crc32UpdateWire } from './crc32Wire'

// Default import (not `{ crc32 }`): `zlib.crc32` landed in Node 22.2.0 / 20.15.0. A named ESM
// import would throw at module load on older runtimes; property access is safe and lets
// `crc32Update` fall back to the pure-JS table below.
//
// Note (Bun AOT / --trim, see https://github.com/oven-sh/bun/issues/47920):
// Importing `node:zlib` currently causes `bun build --compile --aot --trim` to keep all ICU
// locales and profilers (~9.6 MB) and treats `zlib.crc32` as an untyped runtime call.
// Options once #47920 progresses or when integrating Bun-specific paths:
// 1. Prefer `Bun.hash.crc32(slice, seed)` at runtime before `zlib.crc32`.
// 2. Or split `node:zlib` vs `Bun.hash.crc32`/`Bun.zstd*` behind a `"bun"` conditional subpath
//    import in `package.json` (`#native-zlib`) so Node.js and Bun each resolve natively.
const zlibCrc32: typeof zlib.crc32 | undefined =
  typeof zlib.crc32 === 'function' ? zlib.crc32 : undefined

/** Incremental CRC-32 IEEE update; pass the previous return value as `seed`. */
export function crc32Update(
  seed: number,
  buf: Uint8Array,
  start = 0,
  end = buf.length,
): number {
  if (typeof zlibCrc32 === 'function') {
    // `zlib.crc32` returns 0 instead of `seed` for an empty view over a zero-length
    // ArrayBuffer (Node 22.14), which the encoder produces for empty sections.
    if (start >= end) return seed >>> 0
    const slice =
      start === 0 && end === buf.length ? buf : buf.subarray(start, end)
    return zlibCrc32(slice, seed) >>> 0
  }
  return crc32UpdateWire(seed, buf, start, end)
}

/** CRC-32 IEEE (zlib polynomial); uses `zlib.crc32` when available. */
export function crc32Buffer(
  buf: Uint8Array,
  start = 0,
  end = buf.length,
): number {
  return crc32Update(0, buf, start, end)
}
