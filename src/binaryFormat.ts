/** Node-side binary snapshot helpers, gathered for tests and tooling. */
export { BINARY_MAGIC_V5 } from './msv5/binaryMsv5Constants'
export { readMsv5SnapshotCompressionMeta } from './msv5/binaryMsv5ContainerShared'

export { crc32Buffer } from './binaryIo'

export { validateFrozenSnapshot } from './binaryStructures'

export { encodeFrozenSnapshotMsv5 as encodeFrozenSnapshot } from './msv5/binaryMsv5Encode'
export {
  decodeFrozenSnapshotMsv5 as decodeFrozenSnapshot,
  decodeFrozenSnapshotMsv5Async as decodeFrozenSnapshotAsync,
} from './msv5/binaryMsv5Decode'
