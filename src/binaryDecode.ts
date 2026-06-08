import { assertBufferLength, invalidFrozenIndex } from './binaryIo'
import type { FrozenSnapshot } from './binaryStructures'
import {
  decodeFrozenSnapshotMsv5,
  decodeFrozenSnapshotMsv5Async,
  isMsv5Buffer,
  type FrozenDecodeHints,
} from './msv5/binaryMsv5Decode'

const LEGACY_MAGICS = new Set(['MSv1', 'MSv2', 'MSv3', 'MSv4'])

export type { FrozenDecodeHints } from './msv5/binaryMsv5Decode'

/** Decode a frozen binary snapshot buffer. */
export function decodeFrozenSnapshot(buf: Buffer, hints?: FrozenDecodeHints): FrozenSnapshot {
  assertBufferLength(buf, 8)
  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)

  if (isMsv5Buffer(buf) && version === 5) {
    return decodeFrozenSnapshotMsv5(buf, hints)
  }
  if (LEGACY_MAGICS.has(magic)) {
    throw invalidFrozenIndex(
      'Unsupported frozen binary snapshot; re-build with saveBinarySync() or from MiniSearch JSON',
    )
  }
  throw invalidFrozenIndex('Unsupported frozen binary snapshot')
}

/** Async frozen snapshot decode (streaming zstd). */
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
