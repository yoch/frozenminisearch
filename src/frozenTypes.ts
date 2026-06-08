import type { FrozenTermIndex } from './frozenTermIndex'
import type { IdToShortIdLookup } from './frozenIdLookup'
import type { FrozenPostingsLayout } from './frozenPostings'
import type { FieldLengthArray } from './fieldLengthMatrix'
import type { StoredFieldsLayout } from './storedFieldsLayout'
import type { OptionsWithDefaults } from './searchTypes'

export type { OptionsWithDefaults } from './searchTypes'
export type { FieldLengthArray } from './fieldLengthMatrix'

export interface FrozenMemoryBreakdown {
  termCount: number
  documentCount: number
  nextId: number
  postings: {
    slotCount: number
    layout: string
    docIdWidth: number
    allDocIdsBytes: number
    allFreqsBytes: number
    offsetsBytes: number
    lengthsBytes: number
    totalTypedBytes: number
  }
  radixTree: {
    nodeCount: number
    edgeCount: number
    estimatedBytes: number
  }
  documents: {
    externalIdsSlots: number
    storedFieldsSlots: number
    idLookupMode: string
    idToShortIdEntries: number
    fieldLengthMatrixBytes: number
    avgFieldLengthBytes: number
    storedFieldsJsonBytes: number
  }
  estimatedStructuredBytes: number
}

/**
 * Low-level parameters for {@link assembleFrozen} (custom frozen index pipelines).
 * Field types are part of the public surface for advanced assembly; typical apps use
 * {@link buildFrozenFromDocuments}, {@link FrozenMiniSearch.fromJson}, or binary load instead.
 */
export interface FrozenAssembleParams<T = any> {
  options: OptionsWithDefaults<T>
  documentCount: number
  nextId: number
  fieldIds: { [field: string]: number }
  fieldCount: number
  externalIds: unknown[]
  idLookup: IdToShortIdLookup
  storedFields: StoredFieldsLayout
  fieldLengthMatrix: FieldLengthArray
  avgFieldLength: Float32Array
  index: FrozenTermIndex
  termCount: number
  postings: FrozenPostingsLayout
}
