import { CODEC_RAW } from './binaryMsv5Constants'

export interface Msv5PayloadCodecChoice<T extends Uint8Array> {
  payload: T
  codec: number
  zstdLevel: number
}

/** For the `default` of an exhaustive `compression` switch: rejects values outside the declared union at runtime. */
export function unsupportedCompressionError(compression: never): Error {
  return new Error(`FrozenMiniSearch: unsupported compression ${JSON.stringify(compression)}`)
}

export function rawPayloadChoice<T extends Uint8Array>(uncompressed: T): Msv5PayloadCodecChoice<T> {
  return { payload: uncompressed, codec: CODEC_RAW, zstdLevel: 0 }
}

/** Auto mode: one compression attempt; keep it only when strictly smaller than raw. */
export function pickAutoPayloadCodec<T extends Uint8Array>(
  uncompressed: T,
  compressed: T,
  codec: number,
  zstdLevel = 0,
): Msv5PayloadCodecChoice<T> {
  if (compressed.length < uncompressed.length) {
    return { payload: compressed, codec, zstdLevel }
  }
  return rawPayloadChoice(uncompressed)
}
