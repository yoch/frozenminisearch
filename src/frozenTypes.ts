import SearchableMap from './SearchableMap/SearchableMap'
import type { OptionsWithDefaults } from './searchTypes'

export type { OptionsWithDefaults } from './searchTypes'

export interface FreezeSource<T = any> {
  _options: OptionsWithDefaults<T>
  _index: SearchableMap<Map<number, Map<number, number>>>
  _documentCount: number
  _nextId: number
  _documentIds: Map<number, any>
  _fieldIds: { [key: string]: number }
  _fieldLength: Map<number, number[]>
  _avgFieldLength: number[]
  _storedFields: Map<number, Record<string, unknown>>
}

export interface FrozenMemoryBreakdown {
  termCount: number
  documentCount: number
  nextId: number
  postings: {
    slotCount: number
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
  idToShortId: Map<unknown, number>
  storedFields: (Record<string, unknown> | undefined)[]
  fieldLengthMatrix: Uint32Array
  avgFieldLength: Float32Array
  index: SearchableMap<number>
  terms: string[]
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
}
