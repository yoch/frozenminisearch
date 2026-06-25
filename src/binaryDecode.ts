import { assertBufferLength, invalidFrozenIndex } from './binaryIo'
import type { FrozenSnapshot } from './binaryStructures'
import {
  decodeFrozenSnapshotMsv5,
  decodeFrozenSnapshotMsv5Async,
  isMsv5Buffer,
  type FrozenDecodeHints,
} from './msv5/binaryMsv5Decode'

export type { FrozenDecodeHints } from './msv5/binaryMsv5Decode'

/** Decode a frozen binary snapshot buffer. */
export function decodeFrozenSnapshot(buf: Buffer, hints?: FrozenDecodeHints): FrozenSnapshot {
  assertBufferLength(buf, 8)
  const version = buf.readUInt16LE(4)

  if (isMsv5Buffer(buf) && version === 5) {
    return decodeFrozenSnapshotMsv5(buf, hints)
  }
  throw invalidFrozenIndex('Unsupported frozen binary snapshot')
}

/** Async frozen snapshot decode (streaming decompression when needed). */
export async function decodeFrozenSnapshotAsync(
  buf: Buffer,
  hints?: FrozenDecodeHints,
): Promise<FrozenSnapshot> {
  assertBufferLength(buf, 8)
  const version = buf.readUInt16LE(4)

  if (isMsv5Buffer(buf) && version === 5) {
    return decodeFrozenSnapshotMsv5Async(buf, hints)
  }
  return decodeFrozenSnapshot(buf, hints)
}
