import type { FrozenTermIndex } from './frozenTermIndex'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'
import { buildFrozenAssembleParamsFromMiniSearchSnapshot, type MiniSearchSnapshot } from './fromMiniSearch'
import { type AggregateContext, type RawResult } from './scoring'
import { finalizeRawSearchResults } from './scoring'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
} from './searchDefaults'
import {
  decodeFrozenSnapshot,
  decodeFrozenSnapshotAsync,
  encodeFrozenSnapshot,
  encodeFrozenSnapshotAsync,
  fieldNamesFromFieldIds,
} from './binaryFormat'
import { createIdToShortIdLookup, type IdToShortIdLookup } from './frozenIdLookup'
import {
  createFrozenFieldTermFlyweight,
  postingsTypedBytes,
  validateFrozenPostingsLayout,
  type FrozenFieldTermFlyweight,
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
  SearchResult,
  Suggestion,
} from './searchTypes'
import {
  fieldLengthMatrixForWire,
  type FieldLengthArray,
} from './fieldLengthMatrix'
import type {
  FrozenAssembleParams,
  FrozenMemoryBreakdown,
  OptionsWithDefaults,
} from './frozenTypes'
export type { FrozenAssembleParams, FrozenMemoryBreakdown } from './frozenTypes'
export type { MiniSearchSnapshot } from './fromMiniSearch'
import { materializeOwnedSnapshot, type SnapshotOwnershipMode } from './frozenOwnedSnapshot'
import {
  readStoredFields,
  storedFieldsFromRows,
  storedFieldsJsonBytes,
  storedFieldsSlotCount,
  type StoredFieldsLayout,
} from './storedFieldsLayout'
import { WILDCARD_QUERY } from './symbols'

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

function assembleFrozenInternal<T>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
): FrozenMiniSearch<T> {
  const owned = materializeOwnedSnapshot(params, ownershipMode)
  const termCount = owned.termCount
  if (owned.fieldLengthMatrix.length !== owned.nextId * owned.fieldCount) {
    throw new Error('FrozenMiniSearch: fieldLengthMatrix size mismatch')
  }
  if (owned.avgFieldLength.length !== owned.fieldCount) {
    throw new Error('FrozenMiniSearch: avgFieldLength size mismatch')
  }
  if (!trustedSource) {
    validateFrozenPostingsLayout(owned.postings, owned.documentCount, owned.nextId)
    validateFrozenTermIndexLeaves(owned.index, termCount)
  }
  return new FrozenMiniSearch(owned)
}

/** Trusted build paths only (same package); skips O(postings) layout checks. */
function assembleFrozenTrusted<T>(
  params: FrozenAssembleParams<T>,
  ownershipMode: SnapshotOwnershipMode = 'trusted-build',
): FrozenMiniSearch<T> {
  return assembleFrozenInternal(params, true, ownershipMode)
}

/** Instantiate {@link FrozenMiniSearch} from pre-built flat index parts (full validation). */
export function assembleFrozen<T>(params: FrozenAssembleParams<T>): FrozenMiniSearch<T> {
  return assembleFrozenInternal(params, false, 'binary-load')
}

export function buildFrozenFromDocuments<T>(documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
  return assembleFrozenTrusted(buildFrozenParamsFromDocuments(documents, options))
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only index. */
export function freezeFrozenIndexBuilder<T>(builder: FrozenIndexBuilder<T>): FrozenMiniSearch<T> {
  return assembleFrozenTrusted(builder.freezeParams())
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
  private readonly _fieldLengthMatrix: FieldLengthArray
  private readonly _avgFieldLength: Float32Array
  private readonly _storedFields: StoredFieldsLayout
  private readonly _termCount: number
  private readonly _postings: FrozenPostingsLayout
  private readonly _fieldTermFlyweight: FrozenFieldTermFlyweight
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
    this._fieldTermFlyweight = createFrozenFieldTermFlyweight(this._postings)

    this._aggregateContext = {
      documentCount: this._documentCount,
      avgFieldLength: this._avgFieldLength,
      fieldIds: this._fieldIds,
      getFieldLength: (docId, fieldId) => this.getFieldLength(docId, fieldId),
      getExternalId: docId => this._externalIds[docId],
      getStoredFields: docId => readStoredFields(this._storedFields, docId),
    }
    this._queryEngineParams = {
      fields: this._options.fields,
      globalSearchOptions: this._options.searchOptions,
      tokenize: this._options.tokenize,
      processTerm: this._options.processTerm,
      indexView: createFrozenQueryIndexView(
        this._index,
        this._postings,
        this._fieldTermFlyweight,
        (callback) => {
          for (let shortId = 0; shortId < this._nextId; shortId++) {
            const id = this._externalIds[shortId]
            if (id === undefined) continue
            callback(shortId, id, readStoredFields(this._storedFields, shortId))
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

    const storedJson = storedFieldsJsonBytes(this._storedFields)

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
        storedFieldsSlots: storedFieldsSlotCount(this._storedFields),
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
    return shortId == null ? undefined : readStoredFields(this._storedFields, shortId)
  }

  search(query: Query, searchOptions: SearchOptions = {}): SearchResult[] {
    return finalizeRawSearchResults(
      this.executeQuery(query, searchOptions),
      query,
      searchOptions,
      this._options.searchOptions,
      docId => this._externalIds[docId],
      docId => readStoredFields(this._storedFields, docId),
    )
  }

  autoSuggest(queryString: string, options: SearchOptions = {}): Suggestion[] {
    const merged = { ...this._options.autoSuggestOptions, ...options }
    return autoSuggestFromSearch((q, o) => this.search(q, o), queryString, merged)
  }

  /** Serialize this index as a frozen binary snapshot (synchronous). */
  saveBinarySync(): Buffer {
    return encodeFrozenSnapshot({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      fieldNames: fieldNamesFromFieldIds(this._fieldIds),
      avgFieldLength: this._avgFieldLength,
      externalIds: this._externalIds,
      storedFields: new Array(this._nextId),
      storedFieldsLayout: this._storedFields,
      fieldLengthMatrix: fieldLengthMatrixForWire(this._fieldLengthMatrix),
      treeShape: [],
      postings: this._postings,
    }, undefined, this._index)
  }

  /** Non-blocking zstd compression; same output as {@link saveBinarySync}. */
  async saveBinaryAsync(): Promise<Buffer> {
    return encodeFrozenSnapshotAsync({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      fieldNames: fieldNamesFromFieldIds(this._fieldIds),
      avgFieldLength: this._avgFieldLength,
      externalIds: this._externalIds,
      storedFields: new Array(this._nextId),
      storedFieldsLayout: this._storedFields,
      fieldLengthMatrix: fieldLengthMatrixForWire(this._fieldLengthMatrix),
      treeShape: [],
      postings: this._postings,
    }, undefined, this._index)
  }

  /** Load a frozen binary snapshot. */
  static loadBinarySync<T>(buffer: Buffer, options: Options<T> = {} as Options<T>): FrozenMiniSearch<T> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = decodeFrozenSnapshot(buffer, { storeFields })
    return FrozenMiniSearch.fromBinarySnapshot(snap, options)
  }

  /** Load a frozen binary snapshot with streaming zstd decompression (bounded memory). */
  static async loadBinaryAsync<T>(
    buffer: Buffer,
    options: Options<T> = {} as Options<T>,
  ): Promise<FrozenMiniSearch<T>> {
    const storeFields = options.storeFields ?? defaultFrozenLoadOptions.storeFields
    const snap = await decodeFrozenSnapshotAsync(buffer, { storeFields })
    return FrozenMiniSearch.fromBinarySnapshot(snap, options)
  }

  private static fromBinarySnapshot<T>(
    snap: ReturnType<typeof decodeFrozenSnapshot>,
    options: Options<T>,
  ): FrozenMiniSearch<T> {
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
      storedFields: snap.storedFieldsLayout ?? storedFieldsFromRows(snap.storedFields, opts.storeFields),
      fieldLengthMatrix: snap.fieldLengthMatrix,
      avgFieldLength: snap.avgFieldLength,
      index,
      termCount: snap.postings.termCount,
      postings: snap.postings,
    })
  }

  /** Build a read-only index in one pass from documents. */
  static fromDocuments<T>(documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
    return buildFrozenFromDocuments(documents, options)
  }

  /**
   * Convert a lucaong MiniSearch JSON snapshot (`toJSON` / `loadJSON` wire format) into a
   * frozen index. No runtime dependency on the `minisearch` package.
   */
  static fromMiniSearchJson<T>(json: string, options: Options<T> = {} as Options<T>): FrozenMiniSearch<T> {
    return FrozenMiniSearch.fromMiniSearchSnapshot(JSON.parse(json) as MiniSearchSnapshot, options)
  }

  /**
   * Same as {@link fromMiniSearchJson} with a pre-parsed snapshot object.
   * `storedFields` are shallow-copied; callers must not mutate nested values
   * after load if they intend to keep the index immutable.
   */
  static fromMiniSearchSnapshot<T>(
    snapshot: MiniSearchSnapshot,
    options: Options<T> = {} as Options<T>,
  ): FrozenMiniSearch<T> {
    return assembleFrozenTrusted(
      buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options),
      'minisearch-json',
    )
  }

  /** Accepts any object exposing `toJSON()` in lucaong MiniSearch snapshot shape. */
  static fromMiniSearch<T>(
    source: { toJSON(): MiniSearchSnapshot },
    options: Options<T> = {} as Options<T>,
  ): FrozenMiniSearch<T> {
    return FrozenMiniSearch.fromMiniSearchSnapshot(source.toJSON(), options)
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

  private executeQuery(query: Query, searchOptions: SearchOptions = {}): RawResult {
    return runQuery(query, searchOptions, this._queryEngineParams)
  }
}
