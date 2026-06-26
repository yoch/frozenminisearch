import { bytesFromView, type BinaryBytes } from '../binaryBytes'
import { invalidFrozenIndex } from '../frozenErrors'
import {
  buildCoreSectionWithTermCountWire,
  buildExternalIdsSectionWire,
  buildFieldNamesSectionWire,
  buildStoredFieldsSectionWire,
} from '../binaryWireIo'
import {
  deserializeTermIndexTree,
  fieldNamesFromFieldIds,
  termCountOf,
  validateFrozenSnapshotNumeric,
  validateTermTreeLeaves,
  type FrozenSnapshot,
} from '../binaryStructures'
import {
  buildFieldLengthMatrixSection,
  fieldLengthMatrixWireFlags,
} from '../fieldLengthMatrixWire'
import type { FrozenTermIndex } from '../frozenTermIndex'
import { validateFrozenTermIndexLeaves } from '../frozenTermIndex'
import { freqWireFlags } from '../freqPostings'
import { fromRadixTree } from '../PackedRadixTree'
import type { RadixTree } from '../radixTree'
import { buildStoredFieldsWireSection } from '../storedFieldsWire'
import { buildMsv5PostingsSections } from './binaryMsv5Postings'
import { buildTermTreeSectionColumnar } from './packedRadixBinaryMsv5'

export interface Msv5EncodePrepared {
  globalFlags: number
  rawSections: BinaryBytes[]
}

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
  return fromRadixTree(tree, termCount, { skipLeafValidation: true })
}

export function prepareEncodeFrozenSnapshotMsv5(
  snap: FrozenSnapshot,
  termTree?: RadixTree<number>,
  packedTermIndex?: FrozenTermIndex,
): Msv5EncodePrepared {
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

  const storedFieldsSection = snap.storedFieldsLayout != null
    ? buildStoredFieldsWireSection(snap.storedFieldsLayout, snap.nextId)
    : buildStoredFieldsSectionWire(snap.storedFields, snap.nextId)

  const rawSections = [
    buildCoreSectionWithTermCountWire(snap.documentCount, snap.nextId, snap.fieldCount, termCountOf(snap)),
    buildFieldNamesSectionWire(fieldNames),
    buildExternalIdsSectionWire(snap.externalIds, snap.nextId),
    storedFieldsSection,
    buildTermTreeSectionColumnar(packed),
    bytesFromView(snap.avgFieldLength),
    buildFieldLengthMatrixSection(snap.fieldLengthMatrix),
    postingsWire.meta,
    postingsWire.fields,
    postingsWire.optional,
    postingsWire.docIds,
    postingsWire.freqs,
  ]

  return { globalFlags, rawSections }
}
