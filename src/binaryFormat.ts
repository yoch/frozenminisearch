export {
  BINARY_MAGIC_V5,
  BINARY_VERSION_V5,
  CODEC_RAW,
  CODEC_ZLIB,
  CODEC_ZSTD,
  MSV5_FORMAT_REV_PAYLOAD,
  MSV5_ZSTD_LEVEL,
} from './msv5/binaryMsv5Constants'
export {
  readMsv5SnapshotCompressionMeta,
  type Msv5SnapshotCompressionMeta,
} from './msv5/binaryMsv5Compression'
export { encodeFrozenSnapshotMsv5 } from './msv5/binaryMsv5Encode'
export { decodeFrozenSnapshotMsv5, isMsv5Buffer } from './msv5/binaryMsv5Decode'

export { crc32Buffer } from './binaryIo'

export type { FrozenSnapshot } from './binaryStructures'
export {
  fieldNamesFromFieldIds,
  termCountOf,
  validateFrozenSnapshot,
  validateFrozenSnapshotNumeric,
} from './binaryStructures'

export { encodeFrozenSnapshot, encodeFrozenSnapshotAsync } from './binaryEncode'
export { decodeFrozenSnapshot, decodeFrozenSnapshotAsync } from './binaryDecode'
