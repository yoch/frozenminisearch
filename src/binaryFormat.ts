/** @deprecated MSv3/MSv4 identifiers; prefer MSv5 exports below. */
export {
  BINARY_MAGIC_V3,
  BINARY_VERSION_V3,
  BINARY_MAGIC_V4,
  BINARY_VERSION_V4,
} from './binaryConstants'
export {
  BINARY_MAGIC_V5,
  BINARY_VERSION_V5,
  CODEC_RAW,
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

export type { FrozenSnapshot, TreeShape } from './binaryStructures'
export {
  deserializeTermIndexTree,
  fieldNamesFromFieldIds,
  termCountOf,
  validateFrozenSnapshot,
  validateFrozenSnapshotNumeric,
} from './binaryStructures'

export { encodeFrozenSnapshot, encodeFrozenSnapshotAsync } from './binaryEncode'
export { decodeFrozenSnapshot, decodeFrozenSnapshotAsync } from './binaryDecode'
/** @deprecated MSv3/MSv4 term-tree wire helpers. */
export { buildTermTreeSectionFromPacked, readPackedTermTreeSection } from './packedRadixBinary'
