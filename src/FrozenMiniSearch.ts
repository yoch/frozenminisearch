import type { RadixTree } from './SearchableMap/types'
import type { FrozenTermIndex } from './frozenTermIndex'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'
import { fromRadixTree } from './PackedRadixTree'
import {
  finalizeSearchResults,
  type AggregateContext,
  type FieldTermDataLike,
  type RawResult,
} from './scoring'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
} from './searchDefaults'
import {
  decodeFrozenSnapshot,
  encodeFrozenSnapshot,
  fieldNamesFromFieldIds,
} from './binaryFormat'
import { createIdToShortIdLookup, type IdToShortIdLookup } from './frozenIdLookup'
import {
  fieldTermDataFromLayout,
  materializeFrozenPostings,
  postingsTypedBytes,
  validateFrozenPostingsLayout,
  type FrozenPostingsLayout,
} from './frozenPostings'
import {
  buildFrozenParamsFromDocuments,
  createFrozenIndexBuilder,
  type FrozenIndexBuilder,
  type FrozenIndexBuilderHints,
} from './frozenBuild'
import {
  createFrozenQueryIndexView,
  executeQuery as runQuery,
  type QueryEngineParams,
} from './queryEngine'
import { autoSuggestFromSearch } from './suggestions'
import type {
  Options,
  Query,
  SearchOptions,
  SearchOptionsWithDefaults,
  SearchResult,
  Suggestion,
} from './searchTypes'
import type {
  FreezeSource,
  FrozenAssembleParams,
  FrozenMemoryBreakdown,
  OptionsWithDefaults,
} from './frozenTypes'
export type { FreezeSource, FrozenAssembleParams, FrozenMemoryBreakdown } from './frozenTypes'
import { DISCARDED_DOC_ID } from './flatPostings'
import { WILDCARD_QUERY } from './symbols'

const READ_ONLY_MSG = 'FrozenMiniSearch is read-only. Rebuild from a mutable MiniSearch instance.'

function throwReadOnly(): never {
  throw new Error(READ_ONLY_MSG)
}

type MutableFieldTermData = Map<number, Map<number, number>>

export function frozenMemoryBreakdown(frozen: FrozenMiniSearch): FrozenMemoryBreakdown {
  return frozen.memoryBreakdown()
}

function assertFieldsMatchSnapshot(
  optionsFields: readonly string[],
  snapFieldIds: { [field: string]: number },
): void {
  const snapNames = Object.keys(snapFieldIds).sort()
  const optNames = [...optionsFields].sort()
  if (snapNames.length !== optNames.length || snapNames.some((name, i) => name !== optNames[i])) {
    throw new Error(
      `FrozenMiniSearch: option "fields" must match the indexed fields exactly (expected: ${snapNames.join(', ')})`,
    )
  }
}

/** Instantiate {@link FrozenMiniSearch} from pre-built flat index parts. */
export function assembleFrozen<T>(params: FrozenAssembleParams<T>): FrozenMiniSearch<T> {
  const termCount = params.termCount
  validateFrozenPostingsLayout(params.postings, params.documentCount, params.nextId)
  if (params.fieldLengthMatrix.length !== params.nextId * params.fieldCount) {
    throw new Error('FrozenMiniSearch: fieldLengthMatrix size mismatch')
  }
  if (params.avgFieldLength.length !== params.fieldCount) {
    throw new Error('FrozenMiniSearch: avgFieldLength size mismatch')
  }
  validateFrozenTermIndexLeaves(params.index, termCount)
  return new FrozenMiniSearch(params)
}

function buildFlatPostingsFromSource<T>(
  source: FreezeSource<T>,
  fieldCount: number,
  nextId: number,
  shortIdRemap: Uint32Array | null,
): {
  termCount: number
  index: FrozenTermIndex
  postings: FrozenPostingsLayout
} {
  const fieldIndexByTermIndex: MutableFieldTermData[] = []
  const radixTree = source.index.radixTree as RadixTree<MutableFieldTermData>

  const index = fromRadixTree(radixTree, {
    termCount: 0,
    mapLeaf: (leaf) => {
      const ti = fieldIndexByTermIndex.length
      fieldIndexByTermIndex[ti] = leaf
      return ti
    },
    inferTermCountFromLeaves: true,
  })
  const termCount = index.size

  const remapDocId = shortIdRemap != null
    ? (docId: number) => shortIdRemap[docId]
    : undefined
  const postings = materializeFrozenPostings({
    fieldCount,
    termCount,
    nextId,
    clampFrequencies: true,
    remapDocId,
    forEachPosting(ti, f, emit) {
      const freqs = fieldIndexByTermIndex[ti].get(f)
      if (freqs == null) return
      for (const [shortId, freq] of freqs) {
        emit(shortId, freq)
      }
    },
  })

  return { termCount, index, postings }
}

export function freezeFromMiniSearch<T>(source: FreezeSource<T>): FrozenMiniSearch<T> {
  const fieldCount = source.options.fields.length
  const { documentCount, nextId } = source

  const useDense = documentCount < nextId
  let shortIdRemap: Uint32Array | null = null
  const resolvedNextId = useDense ? documentCount : nextId
  const externalIds: unknown[] = new Array(resolvedNextId)
  const storedFields: (Record<string, unknown> | undefined)[] = new Array(externalIds.length)

  if (useDense) {
    shortIdRemap = new Uint32Array(nextId)
    shortIdRemap.fill(DISCARDED_DOC_ID)
    let dense = 0
    for (const [shortId, id] of source.documentIds) {
      shortIdRemap[shortId] = dense
      externalIds[dense] = id
      storedFields[dense] = source.storedFields.get(shortId)
      dense++
    }
  } else {
    for (const [shortId, id] of source.documentIds) {
      externalIds[shortId] = id
      storedFields[shortId] = source.storedFields.get(shortId)
    }
  }

  const idLookup = createIdToShortIdLookup(externalIds, resolvedNextId)

  const matrixRows = useDense ? documentCount : nextId
  const fieldLengthMatrix = new Uint32Array(matrixRows * fieldCount)
  for (const [shortId, lengths] of source.fieldLength) {
    const row = shortIdRemap != null ? shortIdRemap[shortId] : shortId
    if (row === DISCARDED_DOC_ID) continue
    for (let f = 0; f < fieldCount; f++) {
      fieldLengthMatrix[row * fieldCount + f] = lengths[f] ?? 0
    }
  }

  const avgFieldLength = new Float32Array(source.avgFieldLength.length)
  for (let i = 0; i < source.avgFieldLength.length; i++) {
    avgFieldLength[i] = source.avgFieldLength[i]
  }

  const flat = buildFlatPostingsFromSource(source, fieldCount, resolvedNextId, shortIdRemap)

  return assembleFrozen({
    options: source.options,
    documentCount,
    nextId: resolvedNextId,
    fieldIds: source.fieldIds,
    fieldCount,
    externalIds,
    idLookup,
    storedFields,
    fieldLengthMatrix,
    avgFieldLength,
    index: flat.index,
    termCount: flat.termCount,
    postings: flat.postings,
  })
}

export function buildFrozenFromDocuments<T>(documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
  return assembleFrozen(buildFrozenParamsFromDocuments(documents, options))
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only index. */
export function freezeFrozenIndexBuilder<T>(builder: FrozenIndexBuilder<T>): FrozenMiniSearch<T> {
  return assembleFrozen(builder.freezeParams())
}

export default class FrozenMiniSearch<T = any> {
  private readonly _options: OptionsWithDefaults<T>
  private readonly _index: FrozenTermIndex
  private readonly _documentCount: number
  private readonly _nextId: number
  private readonly _externalIds: unknown[]
  private readonly _idLookup: IdToShortIdLookup
  private readonly _fieldIds: { [field: string]: number }
  private readonly _fieldCount: number
  private readonly _fieldLengthMatrix: Uint32Array
  private readonly _avgFieldLength: Float32Array
  private readonly _storedFields: (Record<string, unknown> | undefined)[]
  private readonly _termCount: number
  private readonly _postings: FrozenPostingsLayout
  /** Per-term {@link FieldTermDataLike} views; safe to retain for the instance lifetime (index is immutable). */
  private _fieldTermDataCache: FieldTermDataLike[] | undefined
  private readonly _aggregateContext: AggregateContext
  private readonly _queryEngineParams: QueryEngineParams

  constructor(params: FrozenAssembleParams<T>) {
    this._options = params.options
    this._documentCount = params.documentCount
    this._nextId = params.nextId
    this._externalIds = params.externalIds
    this._idLookup = params.idLookup
    this._fieldIds = params.fieldIds
    this._fieldCount = params.fieldCount
    this._fieldLengthMatrix = params.fieldLengthMatrix
    this._avgFieldLength = params.avgFieldLength
    this._storedFields = params.storedFields
    this._index = params.index
    this._termCount = params.termCount
    this._postings = params.postings

    this._aggregateContext = {
      documentCount: this._documentCount,
      avgFieldLength: this._avgFieldLength,
      fieldIds: this._fieldIds,
      getFieldLength: (docId, fieldId) => this.getFieldLength(docId, fieldId),
      getExternalId: docId => this._externalIds[docId],
      getStoredFields: docId => this._storedFields[docId],
    }
    this._queryEngineParams = {
      fields: this._options.fields,
      globalSearchOptions: this._options.searchOptions,
      tokenize: this._options.tokenize,
      processTerm: this._options.processTerm,
      indexView: createFrozenQueryIndexView(
        this._index,
        ti => this.fieldTermDataFor(ti),
        (callback) => {
          for (let shortId = 0; shortId < this._nextId; shortId++) {
            const id = this._externalIds[shortId]
            if (id === undefined) continue
            callback(shortId, id, this._storedFields[shortId])
          }
        },
      ),
      aggregateContext: this._aggregateContext,
    }
  }

  static readonly wildcard: typeof WILDCARD_QUERY = WILDCARD_QUERY

  get documentCount(): number { return this._documentCount }
  get termCount(): number { return this._termCount }

  memoryBreakdown(): FrozenMemoryBreakdown {
    const termCount = this.termCount
    const postingsStats = postingsTypedBytes(this._postings)

    let storedJson = 0
    for (const row of this._storedFields) {
      if (row != null) storedJson += JSON.stringify(row).length
    }

    const radixEst = this._index.packedByteLength()
    const idMapBytes = this._idLookup.mode === 'lazy-map' ? this._idLookup.mapEntryCount * 32 : 0

    const estimatedStructuredBytes
      = postingsStats.totalTypedBytes
        + this._fieldLengthMatrix.byteLength
        + this._avgFieldLength.byteLength
        + radixEst
        + storedJson
        + idMapBytes

    return {
      termCount,
      documentCount: this._documentCount,
      nextId: this._nextId,
      postings: {
        slotCount: postingsStats.slotCount,
        layout: this._postings.layout,
        docIdWidth: this._postings.docIdWidth,
        allDocIdsBytes: postingsStats.allDocIdsBytes,
        allFreqsBytes: postingsStats.allFreqsBytes,
        offsetsBytes: postingsStats.offsetsBytes,
        lengthsBytes: postingsStats.lengthsBytes,
        totalTypedBytes: postingsStats.totalTypedBytes,
      },
      radixTree: {
        nodeCount: this._index.packedNodeCount(),
        edgeCount: this._index.packedEdgeCount(),
        estimatedBytes: radixEst,
      },
      documents: {
        externalIdsSlots: this._externalIds.length,
        storedFieldsSlots: this._storedFields.length,
        idLookupMode: this._idLookup.mode,
        idToShortIdEntries: this._idLookup.mapEntryCount,
        fieldLengthMatrixBytes: this._fieldLengthMatrix.byteLength,
        avgFieldLengthBytes: this._avgFieldLength.byteLength,
        storedFieldsJsonBytes: storedJson,
      },
      estimatedStructuredBytes,
    }
  }

  has(id: unknown): boolean {
    return this._idLookup.has(id)
  }

  getStoredFields(id: unknown): Record<string, unknown> | undefined {
    const shortId = this._idLookup.get(id)
    return shortId == null ? undefined : this._storedFields[shortId]
  }

  add(): void { throwReadOnly() }
  addAll(): void { throwReadOnly() }
  addAllAsync(): Promise<void> { throwReadOnly() }
  remove(): void { throwReadOnly() }
  removeAll(): void { throwReadOnly() }
  discard(): void { throwReadOnly() }
  discardAll(): void { throwReadOnly() }
  replace(): void { throwReadOnly() }
  vacuum(): Promise<void> { throwReadOnly() }

  search(query: Query, searchOptions: SearchOptions = {}): SearchResult[] {
    const { searchOptions: globalSearchOptions } = this._options
    const searchOptionsWithDefaults: SearchOptionsWithDefaults = { ...globalSearchOptions, ...searchOptions }
    const rawResults = this.executeQuery(query, searchOptions)
    const skipSort = query === FrozenMiniSearch.wildcard && searchOptionsWithDefaults.boostDocument == null
    return finalizeSearchResults({
      rawResults,
      getExternalId: docId => this._externalIds[docId],
      getStoredFields: docId => this._storedFields[docId],
      filter: searchOptionsWithDefaults.filter,
      skipSort,
    })
  }

  autoSuggest(queryString: string, options: SearchOptions = {}): Suggestion[] {
    const merged = { ...this._options.autoSuggestOptions, ...options }
    return autoSuggestFromSearch((q, o) => this.search(q, o), queryString, merged)
  }

  saveBinary(): Buffer {
    return encodeFrozenSnapshot({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      fieldNames: fieldNamesFromFieldIds(this._fieldIds),
      avgFieldLength: this._avgFieldLength,
      externalIds: this._externalIds,
      storedFields: this._storedFields,
      fieldLengthMatrix: this._fieldLengthMatrix,
      treeShape: [],
      postings: this._postings,
    }, undefined, this._index)
  }

  static loadBinary<T>(buffer: Buffer, options: Options<T> = {} as Options<T>): FrozenMiniSearch<T> {
    const snap = decodeFrozenSnapshot(buffer)
    const snapshotFields = snap.fieldNames ?? fieldNamesFromFieldIds(snap.fieldIds)
    if (options.fields != null) {
      assertFieldsMatchSnapshot(options.fields, snap.fieldIds)
    }

    const opts: OptionsWithDefaults<T> = {
      ...defaultFrozenLoadOptions,
      ...options,
      fields: options.fields ?? snapshotFields,
      searchOptions: {
        ...defaultSearchOptions,
        ...(options.searchOptions || {}),
      },
      autoSuggestOptions: { ...defaultAutoSuggestOptions, ...(options.autoSuggestOptions || {}) },
    } as OptionsWithDefaults<T>

    const index = snap.packedTermIndex
    if (index == null) {
      throw new Error('FrozenMiniSearch: binary snapshot missing packed term index')
    }

    const idLookup = createIdToShortIdLookup(snap.externalIds, snap.nextId)

    return assembleFrozen({
      options: opts,
      documentCount: snap.documentCount,
      nextId: snap.nextId,
      fieldIds: snap.fieldIds,
      fieldCount: snap.fieldCount,
      externalIds: snap.externalIds,
      idLookup,
      storedFields: snap.storedFields,
      fieldLengthMatrix: snap.fieldLengthMatrix,
      avgFieldLength: snap.avgFieldLength,
      index,
      termCount: snap.postings.termCount,
      postings: snap.postings,
    })
  }

  /**
   * Build a read-only index in one pass from documents (no mutable MiniSearch step).
   *
   * Use {@link MiniSearch} + {@link MiniSearch#freeze} when you need remove, discard, or
   * incremental updates before freezing.
   */
  static fromDocuments<T>(documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
    return buildFrozenFromDocuments(documents, options)
  }

  /**
   * Build a read-only index from an async stream of documents (e.g. CSV parser).
   * For sync iterables, use {@link createFrozenIndexBuilder} with `for...of` instead.
   *
   * @param hints  Optional builder hints; `estimatedDocumentCount` pre-allocates
   *   per-document arrays when the final document count is known upfront.
   */
  static async fromAsyncIterable<T>(
    iterable: AsyncIterable<T>,
    options: Options<T>,
    hints?: FrozenIndexBuilderHints,
  ): Promise<FrozenMiniSearch<T>> {
    const builder = createFrozenIndexBuilder<T>(options, hints)
    for await (const document of iterable) {
      builder.add(document)
    }
    return freezeFrozenIndexBuilder(builder)
  }

  private getFieldLength(docId: number, fieldId: number): number {
    return this._fieldLengthMatrix[docId * this._fieldCount + fieldId] ?? 0
  }

  private fieldTermDataFor(termIndex: number): FieldTermDataLike {
    let cache = this._fieldTermDataCache
    if (cache == null) {
      cache = new Array(this._termCount)
      this._fieldTermDataCache = cache
    }
    let data = cache[termIndex]
    if (data == null) {
      data = fieldTermDataFromLayout(this._postings, termIndex)
      cache[termIndex] = data
    }
    return data
  }

  private executeQuery(query: Query, searchOptions: SearchOptions = {}): RawResult {
    return runQuery(query, searchOptions, this._queryEngineParams)
  }

}
