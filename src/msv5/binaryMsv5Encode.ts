import type { RadixTree } from '../SearchableMap/types'
import { bufferFromView } from '../binaryIo'
import { invalidFrozenIndex } from '../binaryIo'
import {
  buildCoreSectionWithTermCount,
  buildExternalIdsSection,
  buildFieldNamesSection,
  buildStoredFieldsSection,
  deserializeTermIndexTree,
  fieldNamesFromFieldIds,
  termCountOf,
  validateFrozenSnapshotNumeric,
  validateTermTreeLeaves,
  type FrozenSnapshot,
} from '../binaryStructures'
import type { FrozenTermIndex } from '../frozenTermIndex'
import { validateFrozenTermIndexLeaves } from '../frozenTermIndex'
import { fromRadixTree } from '../PackedRadixTree'
import {
  buildFieldLengthMatrixSection,
  fieldLengthMatrixWireFlags,
} from '../fieldLengthMatrix'
import { freqWireFlags } from '../freqPostings'
import { assembleMsv5File, assembleMsv5FileAsync } from './binaryMsv5Compression'
import { buildMsv5PostingsSections } from './binaryMsv5Postings'
import { buildTermTreeSectionColumnar } from './packedRadixBinaryMsv5'

function resolvePackedTree(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): FrozenTermIndex {
  const termCount = termCountOf(snap)
  const packed = packedTermIndex ?? snap.packedTermIndex
  if (packed != null) {
    validateFrozenTermIndexLeaves(packed, termCount)
    return packed
  }
  const tree = termTree ?? deserializeTermIndexTree(snap.treeShape)
  validateTermTreeLeaves(tree, termCount)
  return fromRadixTree(tree, termCount)
}

export function encodeFrozenSnapshotMsv5(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): Buffer {
  validateFrozenSnapshotNumeric(snap)
  const fieldNames = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
  if (fieldNames.length !== snap.fieldCount) {
    throw invalidFrozenIndex('fieldNames length mismatch')
  }

  const packed = resolvePackedTree(snap, termTree, packedTermIndex)
  const postingsWire = buildMsv5PostingsSections(snap.postings)
  const flFlags = fieldLengthMatrixWireFlags(snap.fieldLengthMatrix)
  const freqFlags = freqWireFlags(snap.postings.allFreqs)

  const globalFlags = postingsWire.flags | flFlags | freqFlags

  const rawSections = [
    buildCoreSectionWithTermCount(snap),
    buildFieldNamesSection(fieldNames),
    buildExternalIdsSection(snap.externalIds, snap.nextId),
    buildStoredFieldsSection(snap.storedFields, snap.nextId),
    buildTermTreeSectionColumnar(packed),
    bufferFromView(snap.avgFieldLength),
    buildFieldLengthMatrixSection(snap.fieldLengthMatrix),
    postingsWire.meta,
    postingsWire.fields,
    postingsWire.optional,
    postingsWire.docIds,
    postingsWire.freqs,
  ]

  return assembleMsv5File(globalFlags, rawSections).buffer
}

export async function encodeFrozenSnapshotMsv5Async(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): Promise<Buffer> {
  validateFrozenSnapshotNumeric(snap)
  const fieldNames = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
  if (fieldNames.length !== snap.fieldCount) {
    throw invalidFrozenIndex('fieldNames length mismatch')
  }

  const packed = resolvePackedTree(snap, termTree, packedTermIndex)
  const postingsWire = buildMsv5PostingsSections(snap.postings)
  const flFlags = fieldLengthMatrixWireFlags(snap.fieldLengthMatrix)
  const freqFlags = freqWireFlags(snap.postings.allFreqs)

  const globalFlags = postingsWire.flags | flFlags | freqFlags

  const rawSections = [
    buildCoreSectionWithTermCount(snap),
    buildFieldNamesSection(fieldNames),
    buildExternalIdsSection(snap.externalIds, snap.nextId),
    buildStoredFieldsSection(snap.storedFields, snap.nextId),
    buildTermTreeSectionColumnar(packed),
    bufferFromView(snap.avgFieldLength),
    buildFieldLengthMatrixSection(snap.fieldLengthMatrix),
    postingsWire.meta,
    postingsWire.fields,
    postingsWire.optional,
    postingsWire.docIds,
    postingsWire.freqs,
  ]

  return (await assembleMsv5FileAsync(globalFlags, rawSections)).buffer
}
