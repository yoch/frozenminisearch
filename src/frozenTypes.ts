import SearchableMap from './SearchableMap/SearchableMap'
import type { IdToShortIdLookup } from './frozenIdLookup'
import type { FrozenPostingsLayout } from './frozenPostings'
import type { OptionsWithDefaults } from './searchTypes'

export type { OptionsWithDefaults } from './searchTypes'

/** Snapshot of a mutable {@link MiniSearch} index for {@link freezeFromMiniSearch}. */
export interface FreezeSource<T = any> {
  options: OptionsWithDefaults<T>
  index: SearchableMap<Map<number, Map<number, number>>>
  documentCount: number
  nextId: number
  documentIds: Map<number, any>
  fieldIds: { [key: string]: number }
  fieldLength: Map<number, number[]>
  avgFieldLength: number[]
  storedFields: Map<number, Record<string, unknown>>
}

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
    mapNodeCount: number
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

export interface FrozenAssembleParams<T = any> {
  options: OptionsWithDefaults<T>
  documentCount: number
  nextId: number
  fieldIds: { [field: string]: number }
  fieldCount: number
  externalIds: unknown[]
  idLookup: IdToShortIdLookup
  storedFields: (Record<string, unknown> | undefined)[]
  fieldLengthMatrix: Uint32Array
  avgFieldLength: Float32Array
  index: SearchableMap<number>
  /** Dictionary size; {@link terms} required only when validating term indices at assembly. */
  termCount: number
  terms?: string[]
  postings: FrozenPostingsLayout
}
