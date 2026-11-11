import { type FrozenSnapshot } from '../binaryStructures'
import { invalidFrozenIndex } from '../frozenErrors'
import {
  buildMsv5EncodePrepared,
  type Msv5EncodePrepared,
} from './binaryMsv5EncodeSections'

/** Encode input for a snapshot that carries its own packed term index (tests, tooling). */
export function prepareEncodeFrozenSnapshotMsv5(
  snap: FrozenSnapshot,
): Msv5EncodePrepared {
  if (snap.packedTermIndex == null) {
    throw invalidFrozenIndex('packedTermIndex is required for binary encode')
  }
  return buildMsv5EncodePrepared(snap, snap.packedTermIndex)
}
