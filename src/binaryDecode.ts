import { assertBufferLength, invalidFrozenIndex } from './binaryIo'
import type { FrozenSnapshot } from './binaryStructures'
import {
  decodeFrozenSnapshotMsv5,
  decodeFrozenSnapshotMsv5Async,
  isMsv5Buffer,
} from './msv5/binaryMsv5Decode'

const LEGACY_MAGICS = new Set(['MSv1', 'MSv2', 'MSv3', 'MSv4'])

/** Decode an MSv5 frozen snapshot buffer. */
export function decodeFrozenSnapshot(buf: Buffer): FrozenSnapshot {
  assertBufferLength(buf, 8)
  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)

  if (isMsv5Buffer(buf) && version === 5) {
    return decodeFrozenSnapshotMsv5(buf)
  }
  if (LEGACY_MAGICS.has(magic)) {
    throw invalidFrozenIndex(
      `${magic} is no longer supported; re-save with saveBinarySync() (MSv5)`,
    )
  }
  throw invalidFrozenIndex(`magic=${magic} version=${version}`)
}

/** Async MSv5 decode (streaming zstd). */
export async function decodeFrozenSnapshotAsync(buf: Buffer): Promise<FrozenSnapshot> {
  assertBufferLength(buf, 8)
  const version = buf.readUInt16LE(4)

  if (isMsv5Buffer(buf) && version === 5) {
    return decodeFrozenSnapshotMsv5Async(buf)
  }
  return decodeFrozenSnapshot(buf)
}
