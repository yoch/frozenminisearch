import { fieldNamesFromFieldIds, type FrozenSnapshot } from './binaryStructures'
import { createIdToShortIdLookup } from './frozenIdLookup'
import type { FrozenAssembleParams } from './frozenTypes'
import {
  assertFieldsMatchSnapshot,
  resolveFrozenOptions,
} from './frozenOptions'
import type { Options } from './searchTypes'
import { storedFieldsFromRows } from './storedFieldsLayout'

type BinarySnapshotState = {
  documentCount: number
  nextId: number
  fieldIds: { [field: string]: number }
  fieldCount: number
  avgFieldLength: Float32Array
  externalIds: unknown[]
  storedFieldsLayout: FrozenSnapshot['storedFieldsLayout']
  fieldLengthMatrix: FrozenSnapshot['fieldLengthMatrix']
  postings: FrozenSnapshot['postings']
}

export function buildBinarySnapshotInput(state: BinarySnapshotState): FrozenSnapshot {
  return {
    documentCount: state.documentCount,
    nextId: state.nextId,
    fieldIds: state.fieldIds,
    fieldCount: state.fieldCount,
    fieldNames: fieldNamesFromFieldIds(state.fieldIds),
    avgFieldLength: state.avgFieldLength,
    externalIds: state.externalIds,
    storedFields: state.storedFieldsLayout != null ? [] : new Array(state.nextId),
    storedFieldsLayout: state.storedFieldsLayout,
    fieldLengthMatrix: state.fieldLengthMatrix,
    postings: state.postings,
  }
}

export function assembleParamsFromBinarySnapshot<T>(
  snap: FrozenSnapshot,
  options: Options<T>,
): FrozenAssembleParams<T> {
  const snapshotFields = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
  if (options.fields != null) {
    assertFieldsMatchSnapshot(options.fields, snap.fieldIds)
  }

  const resolvedOptions = resolveFrozenOptions(options, snapshotFields)

  const index = snap.packedTermIndex
  if (index == null) {
    throw new Error('FrozenMiniSearch: binary snapshot missing packed term index')
  }

  return {
    options: resolvedOptions,
    documentCount: snap.documentCount,
    nextId: snap.nextId,
    fieldIds: snap.fieldIds,
    fieldCount: snap.fieldCount,
    externalIds: snap.externalIds,
    idLookup: createIdToShortIdLookup(snap.externalIds, snap.nextId),
    storedFields: snap.storedFieldsLayout ?? storedFieldsFromRows(snap.storedFields, resolvedOptions.storeFields),
    fieldLengthMatrix: snap.fieldLengthMatrix,
    avgFieldLength: snap.avgFieldLength,
    index,
    termCount: snap.postings.termCount,
    postings: snap.postings,
  }
}
