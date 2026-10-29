import type { FrozenTermIndex } from './frozenTermIndex'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'
import {
  buildFrozenAssembleParamsFromMiniSearchSnapshot,
  type MiniSearchSnapshot,
} from './fromMiniSearch'
import {
  type AggregateContext,
  finalizeRawSearchResults,
  finalizeSearchPage,
  newSearchResult,
  type RawResult,
  resolveResultLimit,
} from './scoring'
import type { IdToShortIdLookup } from './frozenIdLookup'
import {
  createFrozenFieldTermFlyweight,
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
  collectMatchingDocIds,
  createFrozenQueryIndexView,
  executeQuery as runQuery,
  type QueryEngineParams,
  type QueryIndexView,
} from './queryEngine'
import { suggestFromRawResults, suggestFromSearchResults } from './suggestions'
import type {
  MatchIdsOptions,
  Options,
  Query,
  ScoredResult,
  ScoredSearchOptions,
  ScoredSearchPage,
  ScoredSearchPageOptions,
  SearchOptions,
  SearchPageOptions,
  SearchPage,
  SearchResult,
  Suggestion,
} from './searchTypes'
import { type FieldLengthArray } from './fieldLengthMatrix'
import type { FrozenAssembleParams, OptionsWithDefaults } from './frozenTypes'
import { forEachLiveShortId } from './forEachLiveShortId'
import {
  compactExternalIds,
  externalIdResolver,
  materializeExternalIds,
  type FrozenExternalIds,
} from './frozenExternalIds'
import { miniSearchSnapshotFromFrozen } from './toMiniSearch'
import {
  binaryLoadOwnershipModeFromCodec,
  materializeOwnedSnapshot,
  type SnapshotOwnershipMode,
} from './frozenOwnedSnapshot'
import {
  assembleParamsFromBinarySnapshot,
  buildBinarySnapshotInput,
} from './frozenBinaryShared'
import type { FrozenSnapshot } from './binaryStructures'
import { readU8 } from './binaryBytes'
import { MSV5_PAYLOAD_CODEC_OFFSET } from './msv5/binaryMsv5Constants'
import {
  assignStoredFields,
  readStoredFields,
  type StoredFieldsLayout,
} from './storedFieldsLayout'
import { WILDCARD_QUERY } from './symbols'
import {
  getFrozenDefault,
  type FrozenDefaultOptionName,
} from './searchDefaults'
import { frozenRuntimeOptions } from './frozenOptions'

const noStoredFields = (): undefined => undefined
type FrozenMiniSearchCtor<T, I extends FrozenMiniSearchCore<T>> = new (
  params: FrozenAssembleParams<T>,
) => I
export type { FrozenMiniSearchCtor }

export function materializeFrozenAssembleParams<T>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
): FrozenAssembleParams<T> {
  const owned = materializeOwnedSnapshot(params, ownershipMode)
  const termCount = owned.termCount
  if (owned.fieldLengthMatrix.length !== owned.nextId * owned.fieldCount) {
    throw new Error('FrozenMiniSearch: fieldLengthMatrix size mismatch')
  }
  if (owned.avgFieldLength.length !== owned.fieldCount) {
    throw new Error('FrozenMiniSearch: avgFieldLength size mismatch')
  }
  if (!trustedSource) {
    validateFrozenPostingsLayout(
      owned.postings,
      owned.documentCount,
      owned.nextId,
    )
    validateFrozenTermIndexLeaves(owned.index, termCount)
  }
  return owned
}

/** @internal Shared trusted/untrusted assembly entry for product and test harnesses. */
export function assembleFrozenInternal<T>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
): FrozenMiniSearchCore<T>
export function assembleFrozenInternal<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor: FrozenMiniSearchCtor<T, I>,
): I
export function assembleFrozenInternal<T, I extends FrozenMiniSearchCore<T>>(
  params: FrozenAssembleParams<T>,
  trustedSource: boolean,
  ownershipMode: SnapshotOwnershipMode,
  Ctor?: FrozenMiniSearchCtor<T, I>,
): FrozenMiniSearchCore<T> | I {
  const owned = materializeFrozenAssembleParams(
    params,
    trustedSource,
    ownershipMode,
  )
  if (Ctor == null) {
    return new FrozenMiniSearchCore(owned)
  }
  return new Ctor(owned)
}

/**
 * @internal Assemble a frozen index from a decoded binary snapshot, shared by the
 * Node and browser entry points. The decode step already ran
 * {@link validateFrozenSnapshot}, so assembly trusts the snapshot. Ownership is
 * derived from the wire codec: raw payloads alias `wireBuffer` and must be copied,
 * compressed payloads are decoded into an owned allocation and can be kept as-is.
 */
export function assembleFrozenFromBinarySnapshot<
  T,
  I extends FrozenMiniSearchCore<T>,
>(
  snap: FrozenSnapshot,
  options: Options<T>,
  wireBuffer: Uint8Array,
  Ctor: FrozenMiniSearchCtor<T, I>,
): I {
  const ownershipMode = binaryLoadOwnershipModeFromCodec(
    readU8(wireBuffer, MSV5_PAYLOAD_CODEC_OFFSET),
  )
  return assembleFrozenInternal(
    assembleParamsFromBinarySnapshot(snap, options),
    true,
    ownershipMode,
    Ctor,
  )
}

/** @internal Trusted document build for a concrete FrozenMiniSearch subclass. */
export function frozenFromDocumentsWithCtor<
  T,
  I extends FrozenMiniSearchCore<T>,
>(
  Ctor: FrozenMiniSearchCtor<T, I>,
  documents: readonly T[],
  options: Options<T>,
): I {
  return assembleFrozenInternal(
    buildFrozenParamsFromDocuments(documents, options),
    true,
    'trusted-build',
    Ctor,
  )
}

/** @internal Trusted builder finalize for a concrete FrozenMiniSearch subclass. */
export function frozenFromIndexBuilderWithCtor<
  T,
  I extends FrozenMiniSearchCore<T>,
>(Ctor: FrozenMiniSearchCtor<T, I>, builder: FrozenIndexBuilder<T>): I {
  return assembleFrozenInternal(
    builder.freezeParams(),
    true,
    'trusted-build',
    Ctor,
  )
}

export default class FrozenMiniSearchCore<T = any> {
  protected readonly _options: OptionsWithDefaults<T>
  protected readonly _index: FrozenTermIndex
  protected readonly _documentCount: number
  protected readonly _nextId: number
  protected readonly _externalIds: FrozenExternalIds
  protected readonly _getExternalId: (docId: number) => unknown
  protected readonly _idLookup: IdToShortIdLookup
  protected readonly _fieldIds: { [field: string]: number }
  protected readonly _fieldCount: number
  protected readonly _fieldLengthMatrix: FieldLengthArray
  protected readonly _avgFieldLength: Float32Array
  protected readonly _storedFields: StoredFieldsLayout
  protected readonly _termCount: number
  protected readonly _postings: FrozenPostingsLayout
  protected readonly _fieldTermFlyweight: FrozenFieldTermFlyweight
  private readonly _queryEngineParams: QueryEngineParams
  private readonly _hasStoredFields: boolean
  /** Searches in progress on this instance (> 1 when re-entered from `boostDocument`). */
  private _activeQueries = 0

  constructor(params: FrozenAssembleParams<T>) {
    this._options = frozenRuntimeOptions(params.options)
    this._documentCount = params.documentCount
    this._nextId = params.nextId
    this._externalIds = compactExternalIds(params.externalIds, params.idLookup)
    this._getExternalId = externalIdResolver(this._externalIds)
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

    const fieldLengthMatrix = this._fieldLengthMatrix
    const fieldCount = this._fieldCount
    const aggregateContext: AggregateContext = {
      documentCount: this._documentCount,
      avgFieldLength: this._avgFieldLength,
      fieldIds: this._fieldIds,
      getFieldLength: (docId, fieldId) =>
        fieldLengthMatrix[docId * fieldCount + fieldId] | 0,
      getExternalId: this._getExternalId,
      getStoredFields: this._hasStoredFields
        ? (docId) => readStoredFields(this._storedFields, docId)
        : noStoredFields,
    }
    this._queryEngineParams = {
      fields: this._options.fields,
      globalSearchOptions: this._options.searchOptions,
      tokenize: this._options.tokenize,
      processTerm: this._options.processTerm,
      indexView: this._createQueryIndexView(this._fieldTermFlyweight),
      aggregateContext,
    }
  }

  private _createQueryIndexView(
    flyweight: FrozenFieldTermFlyweight,
  ): QueryIndexView {
    return createFrozenQueryIndexView(
      this._index,
      this._postings,
      flyweight,
      this._hasStoredFields
        ? (callback) => {
            forEachLiveShortId(
              this._nextId,
              this._externalIds,
              (shortId, id) => {
                callback(
                  shortId,
                  id,
                  readStoredFields(this._storedFields, shortId),
                )
              },
            )
          }
        : (callback) => {
            forEachLiveShortId(this._nextId, this._externalIds, callback)
          },
      (callback) => {
        forEachLiveShortId(this._nextId, this._externalIds, callback)
      },
    )
  }

  /**
   * The shared posting flyweight is rebound per term and read again per field while scoring,
   * so a search started from `boostDocument` gets its own view instead of rebinding the outer one.
   */
  private _withQueryParams<R>(
    run: (params: QueryEngineParams) => R,
    trackMatch = true,
  ): R {
    let params =
      this._activeQueries === 0
        ? this._queryEngineParams
        : {
            ...this._queryEngineParams,
            indexView: this._createQueryIndexView(
              createFrozenFieldTermFlyweight(this._postings),
            ),
          }
    if (!trackMatch) params = { ...params, trackMatch }
    this._activeQueries++
    try {
      return run(params)
    } finally {
      this._activeQueries--
    }
  }

  private _runQuery(
    query: Query,
    searchOptions: SearchOptions,
    trackMatch = true,
  ): RawResult {
    return this._withQueryParams(
      (params) => runQuery(query, searchOptions, params),
      trackMatch,
    )
  }

  static readonly wildcard: typeof WILDCARD_QUERY = WILDCARD_QUERY

  get documentCount(): number {
    return this._documentCount
  }
  get termCount(): number {
    return this._termCount
  }

  /** Whether a document with the given external id is in the index. */
  has(id: unknown): boolean {
    return this._idLookup.has(id)
  }

  /**
   * Stored fields for a document id, when configured via {@link Options.storeFields}.
   * Returns `undefined` if the id is missing or no fields were stored.
   */
  getStoredFields(id: unknown): Record<string, unknown> | undefined {
    const shortId = this._idLookup.get(id)
    return shortId == null
      ? undefined
      : readStoredFields(this._storedFields, shortId)
  }

  /**
   * Search the index. API and scoring match MiniSearch 7 for the same options.
   *
   * `query` may be a string, {@link FrozenMiniSearchCore.wildcard}, or a nested
   * {@link QueryCombination}. Per-query options override index defaults from
   * {@link Options.searchOptions}; see {@link SearchOptions} for boosts, prefix,
   * fuzzy, filters, and `combineWith`.
   *
   * With `matchInfo: false` (FrozenMiniSearch extension), results have the same
   * scores and order but no `terms` or `match`, and the search skips building them.
   * A filter, including an index-level one, then receives these reduced results.
   *
   * @returns Matches sorted by descending score.
   */
  search(query: Query, searchOptions: ScoredSearchOptions): ScoredResult[]
  search(
    query: Query,
    searchOptions?: SearchOptions & { matchInfo?: true },
  ): SearchResult[]
  search(
    query: Query,
    callOptions: SearchOptions | ScoredSearchOptions = {},
  ): SearchResult[] | ScoredResult[] {
    // Both overloads share one runtime path; a reduced-result filter is typed for that shape only.
    const searchOptions = callOptions as SearchOptions & { matchInfo?: boolean }
    const limit = resolveResultLimit(
      Object.hasOwn(searchOptions, 'limit')
        ? searchOptions.limit
        : this._options.searchOptions.limit,
    )
    if (limit === 0) return []
    const matchInfo = searchOptions.matchInfo !== false
    if (limit !== undefined && query === WILDCARD_QUERY) {
      const options = { ...this._options.searchOptions, ...searchOptions }
      if (options.boostDocument == null)
        return this._searchLimitedWildcard(limit, options.filter, matchInfo)
    }
    return finalizeRawSearchResults(
      this._runQuery(query, searchOptions, matchInfo),
      query,
      searchOptions,
      this._options.searchOptions,
      this._getExternalId,
      undefined,
      this._storedFields,
      matchInfo,
    )
  }

  /**
   * Return a page in the same order as an unbounded {@link search}, with an exact
   * total after filtering. The page size is explicit and overrides index defaults.
   * All candidate scores are computed once. Filters run on every candidate, even
   * for an empty page; without a filter, only returned results are materialized.
   * Assumes finite scores and deterministic filters, as with bounded search.
   * `matchInfo: false` returns results without `terms` or `match`, as with {@link search}.
   */
  searchPage(
    query: Query,
    searchOptions: ScoredSearchPageOptions,
  ): ScoredSearchPage
  searchPage(
    query: Query,
    searchOptions: SearchPageOptions & { matchInfo?: true },
  ): SearchPage
  searchPage(
    query: Query,
    callOptions: SearchPageOptions | ScoredSearchPageOptions,
  ): SearchPage | ScoredSearchPage {
    const searchOptions = callOptions as SearchPageOptions & {
      matchInfo?: boolean
    }
    if (searchOptions == null || searchOptions.limit === undefined) {
      throw new Error('FrozenMiniSearch: searchPage requires an explicit limit')
    }
    const limit = resolveResultLimit(searchOptions.limit)
    const offset = searchOptions.offset === undefined ? 0 : searchOptions.offset
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new Error('FrozenMiniSearch: offset must be a non-negative integer')
    }
    const options = { ...this._options.searchOptions, ...searchOptions }
    const matchInfo = searchOptions.matchInfo !== false
    if (query === WILDCARD_QUERY && options.boostDocument == null) {
      return this._searchWildcardPage(
        offset,
        limit ?? Infinity,
        options.filter,
        matchInfo,
      )
    }
    return finalizeSearchPage(
      {
        rawResults: this._runQuery(query, searchOptions, matchInfo),
        getExternalId: this._getExternalId,
        storedFieldsLayout: this._storedFields,
        filter: options.filter,
        matchInfo,
      },
      offset,
      limit,
    )
  }

  /** Unboosted wildcard pages follow insertion order, so they scan documents without a raw map. */
  private _searchWildcardPage(
    offset: number,
    limit: number,
    filter: SearchOptions['filter'],
    matchInfo: boolean,
  ): SearchPage {
    const results: SearchResult[] = []
    if (filter == null) {
      // Without discarded slots, a short id is the document's rank.
      let skipped = this._documentCount === this._nextId ? offset : 0
      for (
        let shortId = skipped;
        shortId < this._nextId && results.length < limit;
        shortId++
      ) {
        const id = this._getExternalId(shortId)
        if (id === undefined) continue
        if (skipped < offset) skipped++
        else results.push(this._wildcardResult(id, shortId, matchInfo))
      }
      return { results, total: this._documentCount }
    }
    let total = 0
    for (let shortId = 0; shortId < this._nextId; shortId++) {
      const id = this._getExternalId(shortId)
      if (id === undefined) continue
      const result = this._wildcardResult(id, shortId, matchInfo)
      if (!filter(result)) continue
      if (total++ >= offset && results.length < limit) results.push(result)
    }
    return { results, total }
  }

  private _wildcardResult(
    id: unknown,
    shortId: number,
    matchInfo: boolean,
  ): SearchResult {
    const result = newSearchResult(
      id,
      1,
      [],
      matchInfo ? {} : undefined,
      matchInfo,
    )
    assignStoredFields(this._storedFields, shortId, result)
    return result
  }

  /** An unboosted wildcard is already ranked by insertion order; no raw map is needed. */
  private _searchLimitedWildcard(
    limit: number,
    filter: SearchOptions['filter'],
    matchInfo: boolean,
  ): SearchResult[] {
    const results: SearchResult[] = []
    for (
      let shortId = 0;
      shortId < this._nextId && results.length < limit;
      shortId++
    ) {
      const id = this._getExternalId(shortId)
      if (id === undefined) continue
      const result = this._wildcardResult(id, shortId, matchInfo)
      if (filter == null || filter(result)) results.push(result)
    }
    return results
  }

  /**
   * External ids of the documents matching `query`, in insertion order, without
   * scores, match information or result objects (FrozenMiniSearch extension). They
   * are the documents of an unbounded {@link search} with the same options.
   *
   * A filter, local or from the index-level search options, throws: it needs complete
   * results. Pass `filter: undefined` to disable an index-level filter. A local `limit`
   * throws too, since the method returns every match; an index-level limit is ignored.
   * `boostDocument` must be deterministic. As in {@link search}, a document does not
   * match a query term when it returns a falsy value for every term derived from it
   * (exact, prefix or fuzzy). A wildcard query returns every document without calling
   * it, since {@link search} keeps them all, with their boosted scores.
   */
  matchIds(query: Query, searchOptions: MatchIdsOptions = {}): unknown[] {
    const local = searchOptions as SearchOptions
    if ({ ...this._options.searchOptions, ...local }.filter != null) {
      throw new Error(
        'FrozenMiniSearch: matchIds does not support filter (pass filter: undefined to disable an index-level filter)',
      )
    }
    if (local.limit !== undefined)
      throw new Error('FrozenMiniSearch: matchIds does not support limit')

    if (query === WILDCARD_QUERY) {
      const ids: unknown[] = []
      for (let shortId = 0; shortId < this._nextId; shortId++) {
        const id = this._getExternalId(shortId)
        if (id !== undefined) ids.push(id)
      }
      return ids
    }
    const docIds = this._withQueryParams((params) =>
      collectMatchingDocIds(query, searchOptions, params, this._nextId),
    )
    const ids = new Array<unknown>(docIds.length)
    for (let i = 0; i < docIds.length; i++)
      ids[i] = this._getExternalId(docIds[i])
    return ids
  }

  /**
   * Without a `filter`, aggregates suggestions from raw query hits (no full result materialization).
   * With a `filter`, uses {@link search} so stored fields are available to the predicate.
   */
  autoSuggest(queryString: string, options: SearchOptions = {}): Suggestion[] {
    const merged = { ...this._options.autoSuggestOptions, ...options }
    const { filter } = { ...this._options.searchOptions, ...merged }
    if (filter == null) {
      return suggestFromRawResults(this._runQuery(queryString, merged))
    }
    return suggestFromSearchResults(
      this.search(queryString, {
        ...merged,
        limit: undefined,
        matchInfo: undefined,
      }),
    )
  }

  /** Built-in default for indexing / load options (`tokenize`, `processTerm`, `extractField`, …). */
  static getDefault<K extends FrozenDefaultOptionName>(optionName: K) {
    return getFrozenDefault(optionName)
  }

  /**
   * Build a read-only index in one pass from an in-memory document array.
   * Indexing semantics match MiniSearch `addAll` for the same {@link Options}.
   *
   * For custom ingestion (streaming, per-document transforms), use
   * {@link createFrozenIndexBuilder} and {@link freezeFrozenIndexBuilder} instead.
   * The named export {@link buildFrozenFromDocuments} is equivalent on the Node/browser entry.
   */
  static fromDocuments<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    documents: readonly T[],
    options: Options<T>,
  ): I {
    return frozenFromDocumentsWithCtor(this, documents, options)
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
      externalIds: materializeExternalIds(this._externalIds, this._nextId),
      fieldLengthMatrix: this._fieldLengthMatrix,
      avgFieldLength: this._avgFieldLength,
      storedFields: this._storedFields,
      index: this._index,
      fieldTermFlyweight: createFrozenFieldTermFlyweight(this._postings),
    })
  }

  /**
   * Build a new frozen index **from** a MiniSearch JSON snapshot string (import / migration).
   * Accepts the wire format produced by MiniSearch `toJSON` or by {@link toJSON} on this class.
   * No runtime dependency on the `minisearch` package.
   */
  static fromJSON<T, I extends FrozenMiniSearchCore<T>>(
    this: FrozenMiniSearchCtor<T, I>,
    json: string,
    options: Options<T> = {} as Options<T>,
  ): I {
    return assembleFrozenInternal(
      buildFrozenAssembleParamsFromMiniSearchSnapshot(
        JSON.parse(json) as MiniSearchSnapshot,
        options,
      ),
      false,
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
    return assembleFrozenInternal(
      builder.freezeParams(),
      true,
      'trusted-build',
      this,
    )
  }

  protected _binarySnapshotInput(): ReturnType<
    typeof buildBinarySnapshotInput
  > {
    return buildBinarySnapshotInput({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      avgFieldLength: this._avgFieldLength,
      externalIds: materializeExternalIds(this._externalIds, this._nextId),
      storedFieldsLayout: this._storedFields,
      fieldLengthMatrix: this._fieldLengthMatrix,
      postings: this._postings,
    })
  }
}
