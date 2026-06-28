import { bytesFromView, type BinaryBytes } from '../binaryBytes'
import { invalidFrozenIndex } from '../frozenErrors'
import {
  buildCoreSectionWithTermCountWire,
  buildExternalIdsSectionWire,
  buildFieldNamesSectionWire,
  buildStoredFieldsSectionWire,
} from '../binaryWireIo'
import {
  fieldNamesFromFieldIds,
  termCountOf,
  validateFrozenSnapshotNumeric,
  type FrozenSnapshot,
} from '../binaryStructures'
import {
  buildFieldLengthMatrixSection,
  fieldLengthMatrixWireFlags,
} from '../fieldLengthMatrixWire'
import type { FrozenTermIndex } from '../frozenTermIndex'
import { validateFrozenTermIndexLeaves } from '../frozenTermIndex'
import { freqWireFlags } from '../freqPostings'
import { buildStoredFieldsWireSection } from '../storedFieldsWire'
import { buildMsv5PostingsSections } from './binaryMsv5Postings'
import { buildTermTreeSectionColumnar } from './packedRadixBinaryMsv5'

export interface Msv5EncodePrepared {
  globalFlags: number
  rawSections: BinaryBytes[]
}

/** Build MSv5 wire sections from a snapshot and an already-packed term index. */
export function buildMsv5EncodePrepared(
  snap: FrozenSnapshot,
  packedTermIndex: FrozenTermIndex,
): Msv5EncodePrepared {
  validateFrozenSnapshotNumeric(snap)
  const termCount = termCountOf(snap)
  validateFrozenTermIndexLeaves(packedTermIndex, termCount)

  const fieldNames = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
  if (fieldNames.length !== snap.fieldCount) {
    throw invalidFrozenIndex('fieldNames length mismatch')
  }

  const postingsWire = buildMsv5PostingsSections(snap.postings)
  const flFlags = fieldLengthMatrixWireFlags(snap.fieldLengthMatrix)
  const freqFlags = freqWireFlags(snap.postings.allFreqs)
  const globalFlags = postingsWire.flags | flFlags | freqFlags

  const storedFieldsSection = snap.storedFieldsLayout != null
    ? buildStoredFieldsWireSection(snap.storedFieldsLayout, snap.nextId)
    : buildStoredFieldsSectionWire(snap.storedFields, snap.nextId)

  const rawSections = [
    buildCoreSectionWithTermCountWire(snap.documentCount, snap.nextId, snap.fieldCount, termCount),
    buildFieldNamesSectionWire(fieldNames),
    buildExternalIdsSectionWire(snap.externalIds, snap.nextId),
    storedFieldsSection,
    buildTermTreeSectionColumnar(packedTermIndex),
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
