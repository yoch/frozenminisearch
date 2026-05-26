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
  type IndexingOptions,
} from './indexingCore'

export interface FrozenIndexBuilderHints {
  /** Pre-size per-document arrays when the final document count is known. */
  estimatedDocumentCount?: number
}

interface PostingsBuildState {
  fieldCount: number
  terms: string[]
  postingsDocIds: (number[] | undefined)[]
  postingsFreqs: (number[] | undefined)[]
}

function getOrCreateTermIndex(state: PostingsBuildState, index: SearchableMap<number>, term: string): number {
  const existing = index.get(term)
  if (existing != null) return existing
  const ti = state.terms.length
  state.terms.push(term)
  index.set(term, ti)
  return ti
}

function appendPosting(
  state: PostingsBuildState,
  termIndex: number,
  fieldId: number,
  docId: number,
  freq: number,
): void {
  const slot = termIndex * state.fieldCount + fieldId
  let docIds = state.postingsDocIds[slot]
  let freqs = state.postingsFreqs[slot]
  if (docIds == null) {
    docIds = []
    freqs = []
    state.postingsDocIds[slot] = docIds
    state.postingsFreqs[slot] = freqs
  }
  docIds.push(docId)
  freqs!.push(clampFreq(freq))
}

function finalizeFlatPostings(state: PostingsBuildState): {
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
} {
  const termCount = state.terms.length
  const slotCount = termCount * state.fieldCount
  const postingsOffsets = new Uint32Array(slotCount)
  const postingsLengths = new Uint32Array(slotCount)
  const docScratch: number[] = []
  const freqScratch: number[] = []

  for (let ti = 0; ti < termCount; ti++) {
    const base = ti * state.fieldCount
    for (let f = 0; f < state.fieldCount; f++) {
      const offset = docScratch.length
      const docIds = state.postingsDocIds[base + f]
      const freqs = state.postingsFreqs[base + f]
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
    allFreqs: new Uint8Array(freqScratch),
  }
}

/** Incremental builder for {@link FrozenMiniSearch} without materializing a full `documents[]` array. */
export class FrozenIndexBuilder<T> {
  private readonly _options: IndexingOptions<T>
  private readonly _fieldIds: { [key: string]: number }
  private readonly _fieldCount: number
  private readonly _index: SearchableMap<number>
  private readonly _terms: string[]
  private readonly _postingsDocIds: (number[] | undefined)[]
  private readonly _postingsFreqs: (number[] | undefined)[]
  private readonly _externalIds: unknown[]
  private readonly _idToShortId: Map<unknown, number>
  private readonly _storedFields: (Record<string, unknown> | undefined)[]
  private readonly _fieldLengthData: number[]
  private readonly _avgFieldLength: number[]
  private readonly _postingsState: PostingsBuildState
  private _nextId: number
  private _frozen: boolean

  constructor(options: Options<T>, hints?: FrozenIndexBuilderHints) {
    this._options = resolveIndexingOptions(options)
    this._fieldIds = buildFieldIds(this._options.fields)
    this._fieldCount = this._options.fields.length
    this._index = new SearchableMap<number>()
    this._terms = []
    this._postingsDocIds = []
    this._postingsFreqs = []
    this._idToShortId = new Map()
    this._avgFieldLength = []
    this._nextId = 0
    this._frozen = false

    const estimated = hints?.estimatedDocumentCount
    if (estimated != null && estimated > 0) {
      this._externalIds = new Array(estimated)
      this._storedFields = new Array(estimated)
      this._fieldLengthData = new Array(estimated * this._fieldCount).fill(0)
    } else {
      this._externalIds = []
      this._storedFields = []
      this._fieldLengthData = []
    }

    this._postingsState = {
      fieldCount: this._fieldCount,
      terms: this._terms,
      postingsDocIds: this._postingsDocIds,
      postingsFreqs: this._postingsFreqs,
    }
  }

  /** Number of documents indexed so far (not yet frozen). */
  get documentCount(): number {
    return this._nextId
  }

  add(document: T): void {
    if (this._frozen) {
      throw new Error('FrozenIndexBuilder: cannot add after freezeParams()')
    }

    const { extractField, stringifyField, tokenize, processTerm, fields, idField, storeFields } = this._options
    const id = extractField(document, idField)
    if (id == null) {
      throw new Error(`MiniSearch: document does not have ID field "${idField}"`)
    }
    if (this._idToShortId.has(id)) {
      throw new Error(`MiniSearch: duplicate ID ${id}`)
    }

    const shortId = this._nextId++
    this._idToShortId.set(id, shortId)
    this._externalIds[shortId] = id
    this._storedFields[shortId] = saveStoredFieldsForDocument(storeFields, extractField, document)

    const documentCount = shortId + 1

    for (const field of fields) {
      const fieldValue = extractField(document, field)
      if (fieldValue == null) continue

      const tokens = tokenize(stringifyField(fieldValue, field), field)
      const fieldId = this._fieldIds[field]
      const uniqueTerms = new Set(tokens).size
      const localFreqs = collectFieldTermFreqs(tokens, field, processTerm)

      this._fieldLengthData[shortId * this._fieldCount + fieldId] = uniqueTerms
      updateAvgFieldLength(this._avgFieldLength, fieldId, documentCount - 1, uniqueTerms)

      for (const [term, freq] of localFreqs) {
        const ti = getOrCreateTermIndex(this._postingsState, this._index, term)
        appendPosting(this._postingsState, ti, fieldId, shortId, freq)
      }
    }
  }

  /**
   * Finalize this builder into assembly params. Call {@link assembleFrozen} or
   * {@link freezeFrozenIndexBuilder} to obtain a {@link FrozenMiniSearch} instance.
   */
  freezeParams(): FrozenAssembleParams<T> {
    if (this._frozen) {
      throw new Error('FrozenIndexBuilder: freezeParams() already called')
    }
    this._frozen = true

    const documentCount = this._nextId
    const flat = finalizeFlatPostings(this._postingsState)

    const avgFieldLength = new Float32Array(this._fieldCount)
    for (let f = 0; f < this._fieldCount; f++) {
      avgFieldLength[f] = this._avgFieldLength[f] ?? 0
    }

    // Ensure exact size regardless of over- or under-estimated documentCount.
    this._fieldLengthData.length = documentCount * this._fieldCount

    // Trim per-document arrays to actual count when estimatedDocumentCount was too large.
    const externalIds = this._externalIds.length > documentCount
      ? this._externalIds.slice(0, documentCount)
      : this._externalIds
    const storedFields = this._storedFields.length > documentCount
      ? this._storedFields.slice(0, documentCount)
      : this._storedFields

    return {
      options: this._options as FrozenAssembleParams<T>['options'],
      documentCount,
      nextId: documentCount,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      externalIds,
      idToShortId: this._idToShortId,
      storedFields,
      fieldLengthMatrix: new Uint32Array(this._fieldLengthData),
      avgFieldLength,
      index: this._index,
      terms: this._terms,
      postingsOffsets: flat.postingsOffsets,
      postingsLengths: flat.postingsLengths,
      allDocIds: flat.allDocIds,
      allFreqs: flat.allFreqs,
    }
  }
}

/** Create an incremental builder for {@link FrozenMiniSearch}. */
export function createFrozenIndexBuilder<T>(
  options: Options<T>,
  hints?: FrozenIndexBuilderHints,
): FrozenIndexBuilder<T> {
  return new FrozenIndexBuilder(options, hints)
}

export function buildFrozenParamsFromDocuments<T>(
  documents: readonly T[],
  options: Options<T>,
): FrozenAssembleParams<T> {
  const builder = createFrozenIndexBuilder<T>(options, {
    estimatedDocumentCount: documents.length,
  })
  for (let d = 0; d < documents.length; d++) {
    builder.add(documents[d])
  }
  return builder.freezeParams()
}
