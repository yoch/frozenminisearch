import { packTermsFromList } from './PackedRadixTree/packTermList'
import type { Options } from './searchTypes'
import { materializeFieldLengthMatrix } from './fieldLengthMatrix'
import type { FrozenAssembleParams } from './frozenTypes'
import { IncrementalPostingsAccumulator } from './incrementalPostings'
import { createIdToShortIdLookup } from './frozenIdLookup'
import { getFrozenDefault } from './searchDefaults'
import {
  buildFieldIds,
  collectFieldTermFreqsFromFieldInto,
  resolveIndexingOptions,
  updateAvgFieldLength,
  type IndexingOptions,
} from './indexingCore'
import {
  createStoredFieldsLayout,
  resizeStoredFields,
  writeStoredField,
  type StoredFieldsLayout,
} from './storedFieldsLayout'

export interface FrozenIndexBuilderHints {
  /**
   * Pre-size per-document arrays when the final document count is known upfront.
   * Passed to {@link FrozenMiniSearch.fromAsyncIterable} or {@link createFrozenIndexBuilder}.
   */
  estimatedDocumentCount?: number
  /** Hint for initial growable posting column capacity per (term, field) slot. */
  estimatedPostingsPerSlot?: number
}

/** Incremental builder for {@link FrozenMiniSearch} without materializing a full `documents[]` array. */
export class FrozenIndexBuilder<T> {
  private readonly _options: IndexingOptions<T>
  private readonly _fieldIds: { [key: string]: number }
  private readonly _fieldCount: number
  private readonly _termIndex: Map<string, number>
  private readonly _terms: string[]
  private readonly _postings: IncrementalPostingsAccumulator
  private readonly _externalIds: unknown[]
  private readonly _storedFields: StoredFieldsLayout
  private readonly _fieldLengthData: number[]
  private readonly _avgFieldLength: number[]
  private readonly _seenIds: Set<unknown>
  private readonly _fieldTermFreqScratch = new Map<string, number>()
  private readonly _rawTokenScratch = new Set<string>()
  private readonly _tokenScratch: string[] = []
  private _nextId: number
  private _frozen: boolean

  constructor(options: Options<T>, hints?: FrozenIndexBuilderHints) {
    this._options = resolveIndexingOptions(options)
    this._fieldIds = buildFieldIds(this._options.fields)
    this._fieldCount = this._options.fields.length
    this._termIndex = new Map()
    this._terms = []
    const estimatedDocs = hints?.estimatedDocumentCount ?? 0
    const perSlot = hints?.estimatedPostingsPerSlot ?? 4
    this._postings = new IncrementalPostingsAccumulator(this._fieldCount, {
      estimatedTotalPostings: estimatedDocs > 0 ? estimatedDocs * perSlot : undefined,
    })
    this._avgFieldLength = []
    this._seenIds = new Set()
    this._nextId = 0
    this._frozen = false

    const estimated = hints?.estimatedDocumentCount
    this._storedFields = createStoredFieldsLayout(this._options.storeFields, estimated ?? 0)
    if (estimated != null && estimated > 0) {
      this._externalIds = new Array(estimated)
      this._fieldLengthData = new Array(estimated * this._fieldCount).fill(0)
    } else {
      this._externalIds = []
      this._fieldLengthData = []
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
      throw new Error(`FrozenMiniSearch: document does not have ID field "${idField}"`)
    }
    if (this._seenIds.has(id)) {
      throw new Error(`FrozenMiniSearch: duplicate ID ${id}`)
    }
    this._seenIds.add(id)

    const shortId = this._nextId++
    this._externalIds[shortId] = id
    writeStoredField(this._storedFields, shortId, storeFields, extractField, document)

    const documentCount = shortId + 1

    for (const field of fields) {
      const fieldValue = extractField(document, field)
      if (fieldValue == null) continue

      const fieldText = typeof fieldValue === 'string' && stringifyField === getFrozenDefault('stringifyField')
        ? fieldValue
        : stringifyField(fieldValue, field)
      const fieldId = this._fieldIds[field]
      const { fieldLength } = collectFieldTermFreqsFromFieldInto(
        this._fieldTermFreqScratch,
        this._rawTokenScratch,
        this._tokenScratch,
        tokenize,
        fieldText,
        field,
        processTerm,
      )

      this._fieldLengthData[shortId * this._fieldCount + fieldId] = fieldLength
      updateAvgFieldLength(this._avgFieldLength, fieldId, documentCount - 1, fieldLength)

      this._fieldTermFreqScratch.forEach((freq, term) => {
        let ti = this._termIndex.get(term)
        if (ti === undefined) {
          ti = this._terms.length
          this._termIndex.set(term, ti)
          this._terms.push(term)
        }
        this._postings.append(ti, fieldId, shortId, freq)
      })
    }
  }

  /**
   * Adds all the given documents to the index.
   *
   * @param documents  An array of documents to be indexed
   */
  addAll(documents: readonly T[]): void {
    for (const document of documents) this.add(document)
  }

  /**
   * Adds all the given documents to the index asynchronously.
   *
   * Returns a promise that resolves (to `undefined`) when the indexing is done.
   * This method is useful when indexing many documents, to avoid blocking the main
   * thread. The indexing is performed asynchronously and in chunks. Finalize with
   * {@link freezeFrozenIndexBuilder} when done.
   *
   * @param documents  An array of documents to be indexed
   * @param options  Configuration options
   * @return A promise resolving to `undefined` when the indexing is done
   */
  addAllAsync(documents: readonly T[], options: { chunkSize?: number } = {}): Promise<void> {
    const { chunkSize = 10 } = options
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error('FrozenMiniSearch: chunkSize must be a positive integer')
    }
    const acc: { chunk: T[], promise: Promise<void> } = { chunk: [], promise: Promise.resolve() }

    const { chunk, promise } = documents.reduce(({ chunk, promise }, document: T, i: number) => {
      chunk.push(document)
      if ((i + 1) % chunkSize === 0) {
        return {
          chunk: [],
          promise: promise
            .then(() => new Promise(resolve => setTimeout(resolve, 0)))
            .then(() => this.addAll(chunk)),
        }
      } else {
        return { chunk, promise }
      }
    }, acc)

    return promise.then(() => this.addAll(chunk))
  }

  /**
   * Finalize this builder into assembly params. Call {@link freezeFrozenIndexBuilder}
   * to obtain a {@link FrozenMiniSearch} instance.
   */
  freezeParams(): FrozenAssembleParams<T> {
    if (this._frozen) {
      throw new Error('FrozenIndexBuilder: freezeParams() already called')
    }
    this._frozen = true

    const documentCount = this._nextId
    const termCount = this._terms.length
    const postings = this._postings.finalize(termCount, documentCount)

    // Term dedup is no longer needed; drop it before building the radix to
    // keep the freeze-time transient (terms[] + scratch + columns) minimal.
    this._termIndex.clear()
    const index = packTermsFromList(this._terms)
    this._terms.length = 0

    const avgFieldLength = new Float32Array(this._fieldCount)
    for (let f = 0; f < this._fieldCount; f++) {
      avgFieldLength[f] = this._avgFieldLength[f] ?? 0
    }

    this._fieldLengthData.length = documentCount * this._fieldCount

    const externalIds = this._externalIds.length > documentCount
      ? this._externalIds.slice(0, documentCount)
      : this._externalIds
    const storedFields = resizeStoredFields(this._storedFields, documentCount)

    const idLookup = createIdToShortIdLookup(externalIds, documentCount)

    return {
      options: this._options,
      documentCount,
      nextId: documentCount,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      externalIds,
      idLookup,
      storedFields,
      fieldLengthMatrix: materializeFieldLengthMatrix(this._fieldLengthData, documentCount * this._fieldCount),
      avgFieldLength,
      index,
      termCount,
      postings,
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
  builder.addAll(documents)
  return builder.freezeParams()
}
