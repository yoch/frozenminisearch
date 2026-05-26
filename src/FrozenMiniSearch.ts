import SearchableMap from './SearchableMap/SearchableMap'
import { LEAF } from './SearchableMap/TreeIterator'
import type { RadixTree } from './SearchableMap/types'
import {
  finalizeSearchResults,
  type AggregateContext,
  type FieldTermDataLike,
  type RawResult,
} from './scoring'
import { flatFieldTermData } from './compactPostings'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
} from './searchDefaults'
import {
  decodeFrozenSnapshot,
  encodeFrozenSnapshot,
  deserializeTermIndexTree,
  fieldNamesFromFieldIds,
  validateFrozenSnapshotNumeric,
} from './binaryFormat'
import { buildFrozenParamsFromDocuments, createFrozenIndexBuilder, type FrozenIndexBuilder } from './frozenBuild'
import {
  executeQuery as runQuery,
  type QueryEngineParams,
  type QueryIndexView,
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
import { materializeFlatPostings, DISCARDED_DOC_ID } from './flatPostings'
import { WILDCARD_QUERY } from './symbols'

const READ_ONLY_MSG = 'FrozenMiniSearch is read-only. Rebuild from a mutable MiniSearch instance.'

const MAP_NODE_ESTIMATE_BYTES = 120

function throwReadOnly(): never {
  throw new Error(READ_ONLY_MSG)
}

function cloneRadixTreeWithTermIndex(
  tree: RadixTree<Map<number, Map<number, number>>>,
  termIndexByLeaf: WeakMap<Map<number, Map<number, number>>, number>,
): RadixTree<number> {
  const out = new Map() as RadixTree<number>
  for (const [key, val] of tree) {
    if (key === LEAF) {
      const idx = termIndexByLeaf.get(val as Map<number, Map<number, number>>)
      if (idx == null) {
        throw new Error('FrozenMiniSearch: missing term index while cloning tree')
      }
      out.set(LEAF, idx)
    } else {
      out.set(key, cloneRadixTreeWithTermIndex(val as RadixTree<Map<number, Map<number, number>>>, termIndexByLeaf))
    }
  }
  return out
}

function countRadixMapNodes(tree: RadixTree<unknown>): number {
  let n = 1
  for (const [key, val] of tree) {
    if (key !== LEAF) n += countRadixMapNodes(val as RadixTree<unknown>)
  }
  return n
}

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
  // Validate numeric invariants without serialising the radix tree to TreeShape.
  // Full tree-shape validation (including JSON round-trip) is done by the decode
  // path (decodeFrozenSnapshot) for untrusted external binary data.
  validateFrozenSnapshotNumeric(params)
  const termCount = params.terms.length
  for (const [, ti] of params.index) {
    if (!Number.isInteger(ti) || ti < 0 || ti >= termCount) {
      throw new Error(`FrozenMiniSearch: radix tree leaf index out of range: ${ti}`)
    }
  }
  return new FrozenMiniSearch(params)
}

function buildFlatPostingsFromSource<T>(
  source: FreezeSource<T>,
  fieldCount: number,
  shortIdRemap: Uint32Array | null,
): {
  terms: string[]
  tree: RadixTree<number>
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
} {
  const terms: string[] = []
  const fieldIndexByTermIndex: Map<number, Map<number, number>>[] = []
  const leafToIndex = new WeakMap<Map<number, Map<number, number>>, number>()

  for (const [term, fieldIndex] of source._index) {
    const ti = terms.length
    terms.push(term)
    fieldIndexByTermIndex.push(fieldIndex)
    leafToIndex.set(fieldIndex, ti)
  }

  const flat = materializeFlatPostings({
    fieldCount,
    termCount: terms.length,
    clampFrequencies: true,
    remapDocId: shortIdRemap != null ? (docId: number) => shortIdRemap![docId] : undefined,
    forEachPosting(ti, f, emit) {
      const freqs = fieldIndexByTermIndex[ti].get(f)
      if (freqs == null) return
      for (const [shortId, freq] of freqs) {
        emit(shortId, freq)
      }
    },
  })
  const { postingsOffsets, postingsLengths, allDocIds, allFreqs } = flat
  const tree = cloneRadixTreeWithTermIndex(
    source._index.radixTree as RadixTree<Map<number, Map<number, number>>>,
    leafToIndex,
  )

  return { terms, tree, postingsOffsets, postingsLengths, allDocIds, allFreqs }
}

export function freezeFromMiniSearch<T>(source: FreezeSource<T>): FrozenMiniSearch<T> {
  const fieldCount = source._options.fields.length
  const { _documentCount, _nextId } = source

  const useDense = _documentCount < _nextId
  let shortIdRemap: Uint32Array | null = null
  const externalIds: unknown[] = new Array(useDense ? _documentCount : _nextId)
  const storedFields: (Record<string, unknown> | undefined)[] = new Array(externalIds.length)
  const idToShortId = new Map<unknown, number>()

  if (useDense) {
    shortIdRemap = new Uint32Array(_nextId)
    shortIdRemap.fill(DISCARDED_DOC_ID)
    let dense = 0
    for (const [shortId, id] of source._documentIds) {
      shortIdRemap[shortId] = dense
      externalIds[dense] = id
      idToShortId.set(id, dense)
      storedFields[dense] = source._storedFields.get(shortId)
      dense++
    }
  } else {
    for (const [shortId, id] of source._documentIds) {
      externalIds[shortId] = id
      idToShortId.set(id, shortId)
      storedFields[shortId] = source._storedFields.get(shortId)
    }
  }

  const matrixRows = useDense ? _documentCount : _nextId
  const fieldLengthMatrix = new Uint32Array(matrixRows * fieldCount)
  for (const [shortId, lengths] of source._fieldLength) {
    const row = shortIdRemap != null ? shortIdRemap[shortId] : shortId
    if (row === DISCARDED_DOC_ID) continue
    for (let f = 0; f < fieldCount; f++) {
      fieldLengthMatrix[row * fieldCount + f] = lengths[f] ?? 0
    }
  }

  const avgFieldLength = new Float32Array(source._avgFieldLength.length)
  for (let i = 0; i < source._avgFieldLength.length; i++) {
    avgFieldLength[i] = source._avgFieldLength[i]
  }

  const flat = buildFlatPostingsFromSource(source, fieldCount, shortIdRemap)
  const frozenIndex = new SearchableMap<number>(flat.tree)

  return assembleFrozen({
    options: source._options,
    documentCount: _documentCount,
    nextId: useDense ? _documentCount : _nextId,
    fieldIds: source._fieldIds,
    fieldCount,
    externalIds,
    idToShortId,
    storedFields,
    fieldLengthMatrix,
    avgFieldLength,
    index: frozenIndex,
    terms: flat.terms,
    postingsOffsets: flat.postingsOffsets,
    postingsLengths: flat.postingsLengths,
    allDocIds: flat.allDocIds,
    allFreqs: flat.allFreqs,
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
  private readonly _index: SearchableMap<number>
  private readonly _documentCount: number
  private readonly _nextId: number
  private readonly _externalIds: unknown[]
  private readonly _idToShortId: Map<unknown, number>
  private readonly _fieldIds: { [field: string]: number }
  private readonly _fieldCount: number
  private readonly _fieldLengthMatrix: Uint32Array
  private readonly _avgFieldLength: Float32Array
  private readonly _storedFields: (Record<string, unknown> | undefined)[]
  private readonly _terms: string[]
  private readonly _postingsOffsets: Uint32Array
  private readonly _postingsLengths: Uint32Array
  private readonly _allDocIds: Uint32Array
  private readonly _allFreqs: Uint8Array
  private _fieldTermDataCache: FieldTermDataLike[] | undefined

  constructor(params: {
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
  }) {
    this._options = params.options
    this._documentCount = params.documentCount
    this._nextId = params.nextId
    this._externalIds = params.externalIds
    this._idToShortId = params.idToShortId
    this._fieldIds = params.fieldIds
    this._fieldCount = params.fieldCount
    this._fieldLengthMatrix = params.fieldLengthMatrix
    this._avgFieldLength = params.avgFieldLength
    this._storedFields = params.storedFields
    this._index = params.index
    this._terms = params.terms
    this._postingsOffsets = params.postingsOffsets
    this._postingsLengths = params.postingsLengths
    this._allDocIds = params.allDocIds
    this._allFreqs = params.allFreqs
  }

  static readonly wildcard: typeof WILDCARD_QUERY = WILDCARD_QUERY

  get documentCount(): number { return this._documentCount }
  get termCount(): number { return this._index.size }

  memoryBreakdown(): FrozenMemoryBreakdown {
    const termCount = this.termCount
    const slotCount = termCount * this._fieldCount

    const postingsTyped
      = this._allDocIds.byteLength + this._allFreqs.byteLength
        + this._postingsOffsets.byteLength + this._postingsLengths.byteLength

    let storedJson = 0
    for (const row of this._storedFields) {
      if (row != null) storedJson += JSON.stringify(row).length
    }

    const mapNodeCount = countRadixMapNodes(this._index.radixTree)
    const radixEst = mapNodeCount * MAP_NODE_ESTIMATE_BYTES

    const estimatedStructuredBytes
      = postingsTyped
        + this._fieldLengthMatrix.byteLength
        + this._avgFieldLength.byteLength
        + radixEst
        + storedJson
        + this._idToShortId.size * 32

    return {
      termCount,
      documentCount: this._documentCount,
      nextId: this._nextId,
      postings: {
        slotCount,
        allDocIdsBytes: this._allDocIds.byteLength,
        allFreqsBytes: this._allFreqs.byteLength,
        offsetsBytes: this._postingsOffsets.byteLength,
        lengthsBytes: this._postingsLengths.byteLength,
        totalTypedBytes: postingsTyped,
      },
      radixTree: {
        mapNodeCount,
        estimatedBytes: radixEst,
      },
      documents: {
        externalIdsSlots: this._externalIds.length,
        storedFieldsSlots: this._storedFields.length,
        idToShortIdEntries: this._idToShortId.size,
        fieldLengthMatrixBytes: this._fieldLengthMatrix.byteLength,
        avgFieldLengthBytes: this._avgFieldLength.byteLength,
        storedFieldsJsonBytes: storedJson,
      },
      estimatedStructuredBytes,
    }
  }

  has(id: unknown): boolean {
    return this._idToShortId.has(id)
  }

  getStoredFields(id: unknown): Record<string, unknown> | undefined {
    const shortId = this._idToShortId.get(id)
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
      terms: this._terms,
      treeShape: [],
      postingsOffsets: this._postingsOffsets,
      postingsLengths: this._postingsLengths,
      allDocIds: this._allDocIds,
      allFreqs: this._allFreqs,
    }, this._index.radixTree)
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

    const index = new SearchableMap<number>(
      snap.termTree ?? deserializeTermIndexTree(snap.treeShape),
    )

    const idToShortId = new Map<unknown, number>()
    for (let i = 0; i < snap.externalIds.length; i++) {
      if (snap.externalIds[i] !== undefined) {
        idToShortId.set(snap.externalIds[i], i)
      }
    }

    return assembleFrozen({
      options: opts,
      documentCount: snap.documentCount,
      nextId: snap.nextId,
      fieldIds: snap.fieldIds,
      fieldCount: snap.fieldCount,
      externalIds: snap.externalIds,
      idToShortId,
      storedFields: snap.storedFields,
      fieldLengthMatrix: snap.fieldLengthMatrix,
      avgFieldLength: snap.avgFieldLength,
      index,
      terms: snap.terms,
      postingsOffsets: snap.postingsOffsets,
      postingsLengths: snap.postingsLengths,
      allDocIds: snap.allDocIds,
      allFreqs: snap.allFreqs,
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
   */
  static async fromAsyncIterable<T>(
    iterable: AsyncIterable<T>,
    options: Options<T>,
  ): Promise<FrozenMiniSearch<T>> {
    const builder = createFrozenIndexBuilder<T>(options)
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
      cache = new Array(this._terms.length)
      this._fieldTermDataCache = cache
    }
    let data = cache[termIndex]
    if (data == null) {
      data = flatFieldTermData(
        termIndex,
        this._fieldCount,
        this._postingsOffsets,
        this._postingsLengths,
        this._allDocIds,
        this._allFreqs,
      )
      cache[termIndex] = data
    }
    return data
  }

  private aggregateContext(): AggregateContext {
    return {
      documentCount: this._documentCount,
      avgFieldLength: this._avgFieldLength,
      fieldIds: this._fieldIds,
      getFieldLength: (docId, fieldId) => this.getFieldLength(docId, fieldId),
      getExternalId: docId => this._externalIds[docId],
      getStoredFields: docId => this._storedFields[docId],
    }
  }

  private executeQuery(query: Query, searchOptions: SearchOptions = {}): RawResult {
    return runQuery(query, searchOptions, this.queryEngineParams())
  }

  private queryEngineParams(): QueryEngineParams {
    return {
      fields: this._options.fields,
      globalSearchOptions: this._options.searchOptions,
      tokenize: this._options.tokenize,
      processTerm: this._options.processTerm,
      indexView: this.frozenQueryIndexView(),
      aggregateContext: this.aggregateContext(),
    }
  }

  private frozenQueryIndexView(): QueryIndexView {
    const index = this._index
    const fieldTermDataFor = (ti: number) => this.fieldTermDataFor(ti)
    const externalIds = this._externalIds
    const storedFields = this._storedFields
    const nextId = this._nextId
    return {
      getTermData(term) {
        const ti = index.get(term)
        return ti == null ? undefined : fieldTermDataFor(ti)
      },
      * getPrefixMatches(term) {
        for (const [t, ti] of index.atPrefix(term)) {
          yield [t, fieldTermDataFor(ti)]
        }
      },
      getFuzzyMatches(term, maxDistance) {
        const matches = index.fuzzyGet(term, maxDistance)
        if (matches == null) return undefined
        const out = new Map<string, { data: FieldTermDataLike, distance: number }>()
        for (const [t, [ti, distance]] of matches) {
          out.set(t, { data: fieldTermDataFor(ti), distance })
        }
        return out
      },
      forEachActiveDoc(callback) {
        for (let shortId = 0; shortId < nextId; shortId++) {
          const id = externalIds[shortId]
          if (id === undefined) continue
          callback(shortId, id, storedFields[shortId])
        }
      },
    }
  }
}
