import type { FrozenTermIndex } from './frozenTermIndex'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'
import { buildFrozenAssembleParamsFromMiniSearchSnapshot, type MiniSearchSnapshot } from './fromMiniSearch'
import { type AggregateContext, type RawResult, finalizeRawSearchResults } from './scoring'
import type { IdToShortIdLookup } from './frozenIdLookup'
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
import { suggestFromRawResults, suggestFromSearchResults } from './suggestions'
import type {
  Options,
  Query,
  SearchOptions,
  SearchResult,
  Suggestion,
} from './searchTypes'
import { type FieldLengthArray } from './fieldLengthMatrix'
import type {
  FrozenAssembleParams,
  FrozenMemoryBreakdown,
  OptionsWithDefaults,
} from './frozenTypes'
export type { FrozenAssembleParams, FrozenMemoryBreakdown } from './frozenTypes'
export type { MiniSearchSnapshot } from './fromMiniSearch'
import { forEachLiveShortId } from './forEachLiveShortId'
import { miniSearchSnapshotFromFrozen } from './toMiniSearch'
import { materializeOwnedSnapshot, type SnapshotOwnershipMode } from './frozenOwnedSnapshot'
import {
  readStoredFields,
  storedFieldsJsonBytes,
  storedFieldsSlotCount,
  type StoredFieldsLayout,
} from './storedFieldsLayout'
import { WILDCARD_QUERY } from './symbols'
import { getFrozenDefault, type FrozenDefaultOptionName } from './searchDefaults'

export function frozenMemoryBreakdown(frozen: FrozenMiniSearchCore): FrozenMemoryBreakdown {
  return frozen.memoryBreakdown()
}

const noStoredFields = (): undefined => undefined
type FrozenMiniSearchCtor<T, I extends FrozenMiniSearchCore<T>> = new (params: FrozenAssembleParams<T>) => I

function assembleFrozenInternal<T>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
): FrozenMiniSearchCore<T>
function assembleFrozenInternal<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor: FrozenMiniSearchCtor<T, I>,
): I
function assembleFrozenInternal<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor?: FrozenMiniSearchCtor<T, I>,
): FrozenMiniSearchCore<T> | I {
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
  if (Ctor == null) {
    return new FrozenMiniSearchCore(owned)
  }
  return new Ctor(owned)
}

/** @internal Shared assembly path; optional constructor for Node subclass. */
export function assembleFrozenWithCtor<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor: FrozenMiniSearchCtor<T, I>,
): I {
  return assembleFrozenInternal(params, trustedSource, ownershipMode, Ctor)
}

/** Trusted build paths only (same package); skips O(postings) layout checks. */
function assembleFrozenTrusted<T>(
  params: FrozenAssembleParams<T>,
  ownershipMode: SnapshotOwnershipMode = 'trusted-build',
): FrozenMiniSearchCore<T> {
  return assembleFrozenInternal(params, true, ownershipMode)
}

/** Instantiate {@link FrozenMiniSearchCore} from pre-built flat index parts (full validation). */
export function assembleFrozen<T>(params: FrozenAssembleParams<T>): FrozenMiniSearchCore<T> {
  return assembleFrozenInternal(params, false, 'binary-load')
}

export function buildFrozenFromDocuments<T>(documents: readonly T[], options: Options<T>): FrozenMiniSearchCore<T> {
  return assembleFrozenTrusted(buildFrozenParamsFromDocuments(documents, options))
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only index. */
export function freezeFrozenIndexBuilder<T>(builder: FrozenIndexBuilder<T>): FrozenMiniSearchCore<T> {
  return assembleFrozenTrusted(builder.freezeParams())
}

export default class FrozenMiniSearchCore<T = any> {
  protected readonly _options: OptionsWithDefaults<T>
  protected readonly _index: FrozenTermIndex
  protected readonly _documentCount: number
  protected readonly _nextId: number
  protected readonly _externalIds: unknown[]
  protected readonly _idLookup: IdToShortIdLookup
  protected readonly _fieldIds: { [field: string]: number }
  protected readonly _fieldCount: number
  protected readonly _fieldLengthMatrix: FieldLengthArray
  protected readonly _avgFieldLength: Float32Array
  protected readonly _storedFields: StoredFieldsLayout
  protected readonly _termCount: number
  protected readonly _postings: FrozenPostingsLayout
  protected readonly _fieldTermFlyweight: FrozenFieldTermFlyweight
  private readonly _aggregateContext: AggregateContext
  private readonly _queryEngineParams: QueryEngineParams
  private readonly _hasStoredFields: boolean

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
    this._hasStoredFields = this._storedFields.kind !== 'none'

    this._aggregateContext = {
      documentCount: this._documentCount,
      avgFieldLength: this._avgFieldLength,
      fieldIds: this._fieldIds,
      getFieldLength: (docId, fieldId) => this.getFieldLength(docId, fieldId),
      getExternalId: docId => this._externalIds[docId],
      getStoredFields: this._hasStoredFields
        ? docId => readStoredFields(this._storedFields, docId)
        : noStoredFields,
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
        this._hasStoredFields
          ? (callback) => {
              forEachLiveShortId(this._nextId, this._externalIds, (shortId, id) => {
                callback(shortId, id, readStoredFields(this._storedFields, shortId))
              })
            }
          : (callback) => {
              forEachLiveShortId(this._nextId, this._externalIds, callback)
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
      undefined,
      this._storedFields,
    )
  }

  /**
   * Without a `filter`, aggregates suggestions from raw query hits (no full result materialization).
   * With a `filter`, uses {@link search} so stored fields are available to the predicate.
   */
  autoSuggest(queryString: string, options: SearchOptions = {}): Suggestion[] {
    const merged = { ...this._options.autoSuggestOptions, ...options }
    if (merged.filter == null) {
      return suggestFromRawResults(this.executeQuery(queryString, merged))
    }
    return suggestFromSearchResults(this.search(queryString, merged))
  }

  /** Built-in default for indexing / load options (`tokenize`, `processTerm`, `extractField`, …). */
  static getDefault<K extends FrozenDefaultOptionName>(optionName: K) {
    return getFrozenDefault(optionName)
  }

  static fromDocuments<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    documents: readonly T[],
    options: Options<T>,
  ): I {
    return assembleFrozenInternal(buildFrozenParamsFromDocuments(documents, options), true, 'trusted-build', this)
  }

  /**
   * Export this index as a MiniSearch wire snapshot (`serializationVersion: 2`).
   * Use for migration or interchange with the `minisearch` package (`JSON.stringify` works via this method).
   * Term order in `index` may differ from MiniSearch native `toJSON`; search scores stay equivalent.
   */
  toJSON(): MiniSearchSnapshot {
    return miniSearchSnapshotFromFrozen({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      externalIds: this._externalIds,
      fieldLengthMatrix: this._fieldLengthMatrix,
      avgFieldLength: this._avgFieldLength,
      storedFields: this._storedFields,
      index: this._index,
      fieldTermFlyweight: this._fieldTermFlyweight,
    })
  }

  /**
   * Build a new frozen index **from** a MiniSearch JSON snapshot string (import / migration).
   * Accepts the wire format produced by MiniSearch `toJSON` or by {@link toJSON} on this class.
   * No runtime dependency on the `minisearch` package.
   */
  static fromJson<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    json: string,
    options: Options<T> = {} as Options<T>,
  ): I {
    return assembleFrozenInternal(
      buildFrozenAssembleParamsFromMiniSearchSnapshot(JSON.parse(json) as MiniSearchSnapshot, options),
      true,
      'minisearch-json',
      this,
    )
  }

  /**
   * Same as {@link fromJson} with a pre-parsed snapshot object.
   * `storedFields` are shallow-copied; callers must not mutate nested values
   * after load if they intend to keep the index immutable.
   */
  static fromMiniSearchSnapshot<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    snapshot: MiniSearchSnapshot,
    options: Options<T> = {} as Options<T>,
  ): I {
    return assembleFrozenInternal(
      buildFrozenAssembleParamsFromMiniSearchSnapshot(snapshot, options),
      true,
      'minisearch-json',
      this,
    )
  }

  /** Accepts any object exposing `toJSON()` in MiniSearch snapshot shape. */
  static fromMiniSearch<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    source: { toJSON(): MiniSearchSnapshot },
    options: Options<T> = {} as Options<T>,
  ): I {
    return assembleFrozenInternal(
      buildFrozenAssembleParamsFromMiniSearchSnapshot(source.toJSON(), options),
      true,
      'minisearch-json',
      this,
    )
  }

  /**
   * Build a read-only index from an async stream of documents (e.g. CSV parser).
   * For sync iterables, use {@link createFrozenIndexBuilder} with `for...of` instead.
   *
   * @param hints  Optional builder hints; `estimatedDocumentCount` pre-allocates
   *   per-document arrays when the final document count is known upfront.
   */
  static async fromAsyncIterable<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    iterable: AsyncIterable<T>,
    options: Options<T>,
    hints?: FrozenIndexBuilderHints,
  ): Promise<I> {
    const builder = createFrozenIndexBuilder<T>(options, hints)
    for await (const document of iterable) {
      builder.add(document)
    }
    return assembleFrozenInternal(builder.freezeParams(), true, 'trusted-build', this)
  }

  private getFieldLength(docId: number, fieldId: number): number {
    return this._fieldLengthMatrix[docId * this._fieldCount + fieldId] ?? 0
  }

  private executeQuery(query: Query, searchOptions: SearchOptions = {}): RawResult {
    return runQuery(query, searchOptions, this._queryEngineParams)
  }
}
