import {
  type FrozenSnapshot,
} from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import { invalidFrozenIndex } from '../frozenErrors'
import { buildMsv5EncodePrepared, type Msv5EncodePrepared } from './binaryMsv5EncodeSections'

export type { Msv5EncodePrepared }

export function prepareMsv5Encode(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
): Msv5EncodePrepared {
  return buildMsv5EncodePrepared(snap, packedTermIndex)
}

export function prepareEncodeFrozenSnapshotMsv5(
  snap: FrozenSnapshot,
): Msv5EncodePrepared {
  if (snap.packedTermIndex == null) {
    throw invalidFrozenIndex('packedTermIndex is required for binary encode')
  }
  return prepareMsv5Encode(snap, snap.packedTermIndex)
}
