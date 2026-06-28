import {
  deserializeTermIndexTree,
  termCountOf,
  validateTermTreeLeaves,
  type FrozenSnapshot,
} from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import { fromRadixTree } from '../PackedRadixTree'
import type { RadixTree } from '../radixTree'
import { buildMsv5EncodePrepared, type Msv5EncodePrepared } from './binaryMsv5EncodeSections'

export type { Msv5EncodePrepared }

/**
 * Low-level encode helper with legacy fallbacks (`treeShape`, Map radix).
 * Used by tests and benchmarks; product `saveBinary` uses the packed-only path.
 */
function resolvePackedTree(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): FrozenTermIndex {
  const termCount = termCountOf(snap)
  const packed = packedTermIndex ?? snap.packedTermIndex
  if (packed != null) {
    return packed
  }
  const tree = termTree ?? deserializeTermIndexTree(snap.treeShape)
  validateTermTreeLeaves(tree, termCount)
  return fromRadixTree(tree, termCount, { skipLeafValidation: true })
}

export function prepareEncodeFrozenSnapshotMsv5(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): Msv5EncodePrepared {
  // Snapshot numeric / fieldNames validation is owned by buildMsv5EncodePrepared;
  // this wrapper only resolves the legacy term-tree fallback before delegating.
  const packed = resolvePackedTree(snap, termTree, packedTermIndex)
  return buildMsv5EncodePrepared(snap, packed)
}
