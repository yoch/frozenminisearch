export {
  BINARY_MAGIC_V3,
  BINARY_VERSION_V3,
  BINARY_MAGIC_V4,
  BINARY_VERSION_V4,
} from './binaryConstants'

export { crc32Buffer } from './binaryIo'

export type { FrozenSnapshot, TreeShape } from './binaryStructures'
export {
  deserializeTermIndexTree,
  fieldNamesFromFieldIds,
  validateFrozenSnapshot,
  validateFrozenSnapshotNumeric,
} from './binaryStructures'

export { encodeFrozenSnapshot } from './binaryEncode'
export { decodeFrozenSnapshot } from './binaryDecode'
