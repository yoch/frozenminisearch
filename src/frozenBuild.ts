import SearchableMap from './SearchableMap/SearchableMap'
import { clampFreq } from './compactPostings'
import type { Options } from './MiniSearch'
import type { FrozenAssembleParams } from './FrozenMiniSearch'
import {
  buildFieldIds,
  collectFieldTermFreqs,
  resolveIndexingOptions,
  saveStoredFieldsForDocument,
  updateAvgFieldLength,
  type IndexingOptions
} from './indexingCore'

interface FlatIndexBuilder<T> {
  options: IndexingOptions<T>
  fieldIds: { [key: string]: number }
  fieldCount: number
  documentCount: number
  index: SearchableMap<number>
  terms: string[]
  postingsDocIds: (number[] | undefined)[]
  postingsFreqs: (number[] | undefined)[]
  externalIds: unknown[]
  idToShortId: Map<unknown, number>
  storedFields: (Record<string, unknown> | undefined)[]
  fieldLengthMatrix: Uint32Array
  avgFieldLength: number[]
}

function getOrCreateTermIndex (builder: FlatIndexBuilder<unknown>, term: string): number {
  const existing = builder.index.get(term)
  if (existing != null) return existing
  const ti = builder.terms.length
  builder.terms.push(term)
  builder.index.set(term, ti)
  return ti
}

function appendPosting (
  builder: FlatIndexBuilder<unknown>,
  termIndex: number,
  fieldId: number,
  docId: number,
  freq: number
): void {
  const slot = termIndex * builder.fieldCount + fieldId
  let docIds = builder.postingsDocIds[slot]
  let freqs = builder.postingsFreqs[slot]
  if (docIds == null) {
    docIds = []
    freqs = []
    builder.postingsDocIds[slot] = docIds
    builder.postingsFreqs[slot] = freqs
  }
  docIds.push(docId)
  freqs!.push(clampFreq(freq))
}

function finalizeFlatPostings (builder: FlatIndexBuilder<unknown>): {
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
} {
  const termCount = builder.terms.length
  const slotCount = termCount * builder.fieldCount
  const postingsOffsets = new Uint32Array(slotCount)
  const postingsLengths = new Uint32Array(slotCount)
  const docScratch: number[] = []
  const freqScratch: number[] = []

  for (let ti = 0; ti < termCount; ti++) {
    const base = ti * builder.fieldCount
    for (let f = 0; f < builder.fieldCount; f++) {
      const offset = docScratch.length
      const docIds = builder.postingsDocIds[base + f]
      const freqs = builder.postingsFreqs[base + f]
      if (docIds == null || docIds.length === 0) {
        postingsOffsets[base + f] = offset
        postingsLengths[base + f] = 0
        continue
      }
      for (let i = 0; i < docIds.length; i++) {
        docScratch.push(docIds[i])
        freqScratch.push(freqs![i])
      }
      postingsOffsets[base + f] = offset
      postingsLengths[base + f] = docIds.length
    }
  }

  return {
    postingsOffsets,
    postingsLengths,
    allDocIds: new Uint32Array(docScratch),
    allFreqs: new Uint8Array(freqScratch)
  }
}

function indexDocument<T> (builder: FlatIndexBuilder<T>, document: T, shortId: number): void {
  const { extractField, stringifyField, tokenize, processTerm, fields, idField, storeFields } = builder.options
  const id = extractField(document, idField)
  if (id == null) {
    throw new Error(`MiniSearch: document does not have ID field "${idField}"`)
  }
  if (builder.idToShortId.has(id)) {
    throw new Error(`MiniSearch: duplicate ID ${id}`)
  }

  builder.idToShortId.set(id, shortId)
  builder.externalIds[shortId] = id
  builder.storedFields[shortId] = saveStoredFieldsForDocument(storeFields, extractField, document)

  const documentCount = shortId + 1

  for (const field of fields) {
    const fieldValue = extractField(document, field)
    if (fieldValue == null) continue

    const tokens = tokenize(stringifyField(fieldValue, field), field)
    const fieldId = builder.fieldIds[field]
    const uniqueTerms = new Set(tokens).size
    const localFreqs = collectFieldTermFreqs(tokens, field, processTerm)

    builder.fieldLengthMatrix[shortId * builder.fieldCount + fieldId] = uniqueTerms
    updateAvgFieldLength(builder.avgFieldLength, fieldId, documentCount - 1, uniqueTerms)

    for (const [term, freq] of localFreqs) {
      const ti = getOrCreateTermIndex(builder as FlatIndexBuilder<unknown>, term)
      appendPosting(builder as FlatIndexBuilder<unknown>, ti, fieldId, shortId, freq)
    }
  }
}

function createBuilder<T> (options: IndexingOptions<T>, documentCount: number): FlatIndexBuilder<T> {
  const fieldCount = options.fields.length
  return {
    options,
    fieldIds: buildFieldIds(options.fields),
    fieldCount,
    documentCount,
    index: new SearchableMap<number>(),
    terms: [],
    postingsDocIds: [],
    postingsFreqs: [],
    externalIds: new Array(documentCount),
    idToShortId: new Map(),
    storedFields: new Array(documentCount),
    fieldLengthMatrix: new Uint32Array(documentCount * fieldCount),
    avgFieldLength: []
  }
}

export function buildFrozenParamsFromDocuments<T> (
  documents: readonly T[],
  options: Options<T>
): FrozenAssembleParams<T> {
  const resolved = resolveIndexingOptions(options)
  const documentCount = documents.length
  const builder = createBuilder(resolved, documentCount)

  for (let d = 0; d < documentCount; d++) {
    indexDocument(builder, documents[d], d)
  }

  const flat = finalizeFlatPostings(builder as FlatIndexBuilder<unknown>)
  const avgFieldLength = new Float32Array(builder.fieldCount)
  for (let f = 0; f < builder.fieldCount; f++) {
    avgFieldLength[f] = builder.avgFieldLength[f] ?? 0
  }

  return {
    options: resolved as FrozenAssembleParams<T>['options'],
    documentCount,
    nextId: documentCount,
    fieldIds: builder.fieldIds,
    fieldCount: builder.fieldCount,
    externalIds: builder.externalIds,
    idToShortId: builder.idToShortId,
    storedFields: builder.storedFields,
    fieldLengthMatrix: builder.fieldLengthMatrix,
    avgFieldLength,
    index: builder.index,
    terms: builder.terms,
    postingsOffsets: flat.postingsOffsets,
    postingsLengths: flat.postingsLengths,
    allDocIds: flat.allDocIds,
    allFreqs: flat.allFreqs
  }
}
