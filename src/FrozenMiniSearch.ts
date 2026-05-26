import SearchableMap from './SearchableMap/SearchableMap'
import { LEAF } from './SearchableMap/TreeIterator'
import type { RadixTree } from './SearchableMap/types'
import {
  aggregateTerm,
  combineResults,
  finalizeSearchResults,
  termToQuerySpec,
  getOwnProperty,
  type RawResult,
  type QuerySpec,
  type FieldTermDataLike
} from './scoring'
import { clampFreq, flatFieldTermData } from './compactPostings'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions
} from './searchDefaults'
import {
  decodeFrozenSnapshot,
  encodeFrozenSnapshot,
  deserializeTermIndexTree,
  serializeTermIndexTree
} from './binaryFormat'
import { buildFrozenParamsFromDocuments, createFrozenIndexBuilder, type FrozenIndexBuilder } from './frozenBuild'
import type {
  Options,
  Query,
  SearchOptions,
  SearchResult,
  CombinationOperator,
  BM25Params
} from './MiniSearch'
import { WILDCARD_QUERY } from './symbols'

type SearchOptionsWithDefaults = SearchOptions & {
  boost: { [fieldName: string]: number }
  weights: { fuzzy: number, prefix: number }
  prefix: boolean | ((term: string, index: number, terms: string[]) => boolean)
  fuzzy: boolean | number | ((term: string, index: number, terms: string[]) => boolean | number)
  maxFuzzy: number
  combineWith: CombinationOperator
  bm25: BM25Params
}

type OptionsWithDefaults<T> = Options<T> & {
  storeFields: string[]
  idField: string
  extractField: (document: T, fieldName: string) => any
  stringifyField: (fieldValue: any, fieldName: string) => string
  tokenize: (text: string, fieldName: string) => string[]
  processTerm: (term: string, fieldName: string) => string | string[] | null | undefined | false
  searchOptions: SearchOptionsWithDefaults
  autoSuggestOptions: SearchOptions
}

const READ_ONLY_MSG = 'FrozenMiniSearch is read-only. Rebuild from a mutable MiniSearch instance.'

const MAP_NODE_ESTIMATE_BYTES = 120

function throwReadOnly (): never {
  throw new Error(READ_ONLY_MSG)
}

function cloneRadixTreeWithTermIndex (
  tree: RadixTree<Map<number, Map<number, number>>>,
  termIndexByLeaf: WeakMap<Map<number, Map<number, number>>, number>
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

function countRadixMapNodes (tree: RadixTree<unknown>): number {
  let n = 1
  for (const [key, val] of tree) {
    if (key !== LEAF) n += countRadixMapNodes(val as RadixTree<unknown>)
  }
  return n
}

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

export function frozenMemoryBreakdown (frozen: FrozenMiniSearch): FrozenMemoryBreakdown {
  return frozen.memoryBreakdown()
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

/** Instantiate {@link FrozenMiniSearch} from pre-built flat index parts. */
export function assembleFrozen<T> (params: FrozenAssembleParams<T>): FrozenMiniSearch<T> {
  return new FrozenMiniSearch(params)
}

function buildFlatPostingsFromSource<T> (
  source: FreezeSource<T>,
  fieldCount: number,
  shortIdRemap: Uint32Array | null
): {
  terms: string[]
  tree: RadixTree<number>
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
} {
  const terms: string[] = []
  const leafToIndex = new WeakMap<Map<number, Map<number, number>>, number>()

  for (const [term, fieldIndex] of source._index) {
    const ti = terms.length
    terms.push(term)
    leafToIndex.set(fieldIndex, ti)
  }

  const termCount = terms.length
  const slotCount = termCount * fieldCount
  const postingsOffsets = new Uint32Array(slotCount)
  const postingsLengths = new Uint32Array(slotCount)
  const docScratch: number[] = []
  const freqScratch: number[] = []

  for (const [, fieldIndex] of source._index) {
    const ti = leafToIndex.get(fieldIndex)!
    const base = ti * fieldCount

    for (let f = 0; f < fieldCount; f++) {
      const offset = docScratch.length
      const freqs = fieldIndex.get(f)
      if (freqs == null || freqs.size === 0) {
        postingsOffsets[base + f] = offset
        postingsLengths[base + f] = 0
        continue
      }
      let count = 0
      for (const [shortId, freq] of freqs) {
        const docId = shortIdRemap != null ? shortIdRemap[shortId] : shortId
        // Skip discarded docs when dense remapping is enabled. This prevents
        // invalid docIds (no externalId) from leaking into frozen search results.
        if (docId === 0xffffffff) continue
        docScratch.push(docId)
        freqScratch.push(clampFreq(freq))
        count++
      }
      postingsOffsets[base + f] = offset
      postingsLengths[base + f] = count
    }
  }

  const allDocIds = new Uint32Array(docScratch)
  const allFreqs = new Uint8Array(freqScratch)
  const tree = cloneRadixTreeWithTermIndex(
    source._index.radixTree as RadixTree<Map<number, Map<number, number>>>,
    leafToIndex
  )

  return { terms, tree, postingsOffsets, postingsLengths, allDocIds, allFreqs }
}

export function freezeFromMiniSearch<T> (source: FreezeSource<T>): FrozenMiniSearch<T> {
  const fieldCount = source._options.fields.length
  const { _documentCount, _nextId } = source

  const useDense = _documentCount < _nextId
  let shortIdRemap: Uint32Array | null = null
  const externalIds: unknown[] = new Array(useDense ? _documentCount : _nextId)
  const storedFields: (Record<string, unknown> | undefined)[] = new Array(externalIds.length)
  const idToShortId = new Map<unknown, number>()

  if (useDense) {
    shortIdRemap = new Uint32Array(_nextId)
    shortIdRemap.fill(0xffffffff)
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
    if (row === 0xffffffff) continue
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
    allFreqs: flat.allFreqs
  })
}

export function buildFrozenFromDocuments<T> (documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
  return assembleFrozen(buildFrozenParamsFromDocuments(documents, options))
}

/** Finalize a {@link FrozenIndexBuilder} into a read-only index. */
export function freezeFrozenIndexBuilder<T> (builder: FrozenIndexBuilder<T>): FrozenMiniSearch<T> {
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

  constructor (params: {
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

  get documentCount (): number { return this._documentCount }
  get termCount (): number { return this._index.size }

  memoryBreakdown (): FrozenMemoryBreakdown {
    const termCount = this.termCount
    const slotCount = termCount * this._fieldCount

    const postingsTyped =
      this._allDocIds.byteLength + this._allFreqs.byteLength +
      this._postingsOffsets.byteLength + this._postingsLengths.byteLength

    let storedJson = 0
    for (const row of this._storedFields) {
      if (row != null) storedJson += JSON.stringify(row).length
    }

    const mapNodeCount = countRadixMapNodes(this._index.radixTree)
    const radixEst = mapNodeCount * MAP_NODE_ESTIMATE_BYTES

    const estimatedStructuredBytes =
      postingsTyped +
      this._fieldLengthMatrix.byteLength +
      this._avgFieldLength.byteLength +
      radixEst +
      storedJson +
      this._idToShortId.size * 32

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
        totalTypedBytes: postingsTyped
      },
      radixTree: {
        mapNodeCount,
        estimatedBytes: radixEst
      },
      documents: {
        externalIdsSlots: this._externalIds.length,
        storedFieldsSlots: this._storedFields.length,
        idToShortIdEntries: this._idToShortId.size,
        fieldLengthMatrixBytes: this._fieldLengthMatrix.byteLength,
        avgFieldLengthBytes: this._avgFieldLength.byteLength,
        storedFieldsJsonBytes: storedJson
      },
      estimatedStructuredBytes
    }
  }

  has (id: unknown): boolean {
    return this._idToShortId.has(id)
  }

  getStoredFields (id: unknown): Record<string, unknown> | undefined {
    const shortId = this._idToShortId.get(id)
    return shortId == null ? undefined : this._storedFields[shortId]
  }

  add (): void { throwReadOnly() }
  addAll (): void { throwReadOnly() }
  addAllAsync (): Promise<void> { throwReadOnly() }
  remove (): void { throwReadOnly() }
  removeAll (): void { throwReadOnly() }
  discard (): void { throwReadOnly() }
  discardAll (): void { throwReadOnly() }
  replace (): void { throwReadOnly() }
  vacuum (): Promise<void> { throwReadOnly() }

  search (query: Query, searchOptions: SearchOptions = {}): SearchResult[] {
    const { searchOptions: globalSearchOptions } = this._options
    const searchOptionsWithDefaults: SearchOptionsWithDefaults = { ...globalSearchOptions, ...searchOptions }
    const rawResults = this.executeQuery(query, searchOptions)
    const skipSort = query === FrozenMiniSearch.wildcard && searchOptionsWithDefaults.boostDocument == null
    return finalizeSearchResults({
      rawResults,
      getExternalId: (docId) => this._externalIds[docId],
      getStoredFields: (docId) => this._storedFields[docId],
      filter: searchOptionsWithDefaults.filter,
      skipSort
    })
  }

  autoSuggest (queryString: string, options: SearchOptions = {}): import('./MiniSearch').Suggestion[] {
    options = { ...this._options.autoSuggestOptions, ...options }
    const suggestions: Map<string, { score: number, terms: string[], count: number }> = new Map()

    for (const { score, terms } of this.search(queryString, options)) {
      const phrase = terms.join(' ')
      const suggestion = suggestions.get(phrase)
      if (suggestion != null) {
        suggestion.score += score
        suggestion.count += 1
      } else {
        suggestions.set(phrase, { score, terms, count: 1 })
      }
    }

    return [...suggestions.entries()]
      .map(([suggestion, { score, terms, count }]) => ({
        suggestion,
        terms,
        score: score / count
      }))
      .sort((a, b) => b.score - a.score)
  }

  saveBinary (): Buffer {
    return encodeFrozenSnapshot({
      documentCount: this._documentCount,
      nextId: this._nextId,
      fieldIds: this._fieldIds,
      fieldCount: this._fieldCount,
      avgFieldLength: this._avgFieldLength,
      externalIds: this._externalIds,
      storedFields: this._storedFields,
      fieldLengthMatrix: this._fieldLengthMatrix,
      terms: this._terms,
      treeShape: serializeTermIndexTree(this._index.radixTree),
      postingsOffsets: this._postingsOffsets,
      postingsLengths: this._postingsLengths,
      allDocIds: this._allDocIds,
      allFreqs: this._allFreqs
    })
  }

  static loadBinary<T> (buffer: Buffer, options: Options<T>): FrozenMiniSearch<T> {
    if (options?.fields == null) {
      throw new Error('FrozenMiniSearch: option "fields" must be provided')
    }
    const snap = decodeFrozenSnapshot(buffer)
    const fieldNames = options.fields
    for (const name of fieldNames) {
      if (snap.fieldIds[name] === undefined) {
        throw new Error(`FrozenMiniSearch: field "${name}" not found in frozen index`)
      }
    }

    const opts: OptionsWithDefaults<T> = {
      ...defaultFrozenLoadOptions,
      ...options,
      searchOptions: {
        ...defaultSearchOptions,
        ...(options.searchOptions || {})
      },
      autoSuggestOptions: { ...defaultAutoSuggestOptions, ...(options.autoSuggestOptions || {}) }
    } as OptionsWithDefaults<T>

    const index = new SearchableMap<number>(deserializeTermIndexTree(snap.treeShape))

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
      allFreqs: snap.allFreqs
    })
  }

  /**
   * Build a read-only index in one pass from documents (no mutable MiniSearch step).
   *
   * Use {@link MiniSearch} + {@link MiniSearch#freeze} when you need remove, discard, or
   * incremental updates before freezing.
   */
  static fromDocuments<T> (documents: readonly T[], options: Options<T>): FrozenMiniSearch<T> {
    return buildFrozenFromDocuments(documents, options)
  }

  /**
   * Build a read-only index from an async stream of documents (e.g. CSV parser).
   * For sync iterables, use {@link createFrozenIndexBuilder} with `for...of` instead.
   */
  static async fromAsyncIterable<T> (
    iterable: AsyncIterable<T>,
    options: Options<T>
  ): Promise<FrozenMiniSearch<T>> {
    const builder = createFrozenIndexBuilder<T>(options)
    for await (const document of iterable) {
      builder.add(document)
    }
    return freezeFrozenIndexBuilder(builder)
  }

  private getFieldLength (docId: number, fieldId: number): number {
    return this._fieldLengthMatrix[docId * this._fieldCount + fieldId] ?? 0
  }

  private fieldTermDataFor (termIndex: number): FieldTermDataLike {
    return flatFieldTermData(
      termIndex,
      this._fieldCount,
      this._postingsOffsets,
      this._postingsLengths,
      this._allDocIds,
      this._allFreqs
    )
  }

  private aggregateContext () {
    return {
      documentCount: this._documentCount,
      avgFieldLength: this._avgFieldLength,
      fieldIds: this._fieldIds,
      getFieldLength: (docId: number, fieldId: number) => this.getFieldLength(docId, fieldId),
      getExternalId: (docId: number) => this._externalIds[docId],
      getStoredFields: (docId: number) => this._storedFields[docId]
    }
  }

  private termResults (
    sourceTerm: string,
    derivedTerm: string,
    termWeight: number,
    termBoost: number,
    termIndex: number | undefined,
    fieldBoosts: { [field: string]: number },
    boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,
    bm25params: BM25Params,
    results: RawResult = new Map()
  ): RawResult {
    if (termIndex == null) return results
    return aggregateTerm(
      sourceTerm,
      derivedTerm,
      termWeight,
      termBoost,
      this.fieldTermDataFor(termIndex),
      fieldBoosts,
      this.aggregateContext(),
      boostDocumentFn,
      bm25params,
      results
    )
  }

  private executeQuery (query: Query, searchOptions: SearchOptions = {}): RawResult {
    if (query === FrozenMiniSearch.wildcard) {
      return this.executeWildcardQuery(searchOptions)
    }

    if (typeof query !== 'string') {
      const options = { ...searchOptions, ...query, queries: undefined }
      const results = query.queries.map((subquery) => this.executeQuery(subquery, options))
      return combineResults(results, options.combineWith as CombinationOperator)
    }

    const { tokenize, processTerm, searchOptions: globalSearchOptions } = this._options
    const options = { tokenize, processTerm, ...globalSearchOptions, ...searchOptions }
    const { tokenize: searchTokenize, processTerm: searchProcessTerm } = options
    const terms = searchTokenize(query)
      .flatMap((term: string) => searchProcessTerm(term))
      .filter((term) => !!term) as string[]
    const queries: QuerySpec[] = terms.map(termToQuerySpec(options))
    const results = queries.map((q) => this.executeQuerySpec(q, options))
    return combineResults(results, options.combineWith as CombinationOperator)
  }

  private executeQuerySpec (query: QuerySpec, searchOptions: SearchOptions): RawResult {
    const options: SearchOptionsWithDefaults = { ...this._options.searchOptions, ...searchOptions }
    const boosts = (options.fields || this._options.fields).reduce<{ [field: string]: number }>(
      (b: { [field: string]: number }, field: string) => ({ ...b, [field]: (getOwnProperty(options.boost as Record<string, unknown>, field) as number) || 1 }),
      {}
    )
    const { boostDocument, weights, maxFuzzy, bm25: bm25params } = options
    const fuzzyWeight = weights?.fuzzy ?? 0.45
    const prefixWeight = weights?.prefix ?? 0.375

    const termIndex = this._index.get(query.term)
    const results = this.termResults(query.term, query.term, 1, query.termBoost, termIndex, boosts, boostDocument, bm25params)

    let prefixMatches: SearchableMap<number> | undefined
    let fuzzyMatches: ReturnType<SearchableMap<number>['fuzzyGet']> | undefined

    if (query.prefix) {
      prefixMatches = this._index.atPrefix(query.term)
    }

    if (query.fuzzy) {
      const fuzzy = (query.fuzzy === true) ? 0.2 : query.fuzzy
      const maxDistance = fuzzy < 1
        ? Math.min(maxFuzzy, Math.round(query.term.length * fuzzy))
        : fuzzy
      if (maxDistance) fuzzyMatches = this._index.fuzzyGet(query.term, maxDistance)
    }

    if (prefixMatches) {
      for (const [term, ti] of prefixMatches) {
        const distance = term.length - query.term.length
        if (!distance) continue
        fuzzyMatches?.delete(term)
        const weight = prefixWeight * term.length / (term.length + 0.3 * distance)
        this.termResults(query.term, term, weight, query.termBoost, ti, boosts, boostDocument, bm25params, results)
      }
    }

    if (fuzzyMatches) {
      for (const term of fuzzyMatches.keys()) {
        const [ti, distance] = fuzzyMatches.get(term)!
        if (!distance) continue
        const weight = fuzzyWeight * term.length / (term.length + distance)
        this.termResults(query.term, term, weight, query.termBoost, ti, boosts, boostDocument, bm25params, results)
      }
    }

    return results
  }

  private executeWildcardQuery (searchOptions: SearchOptions): RawResult {
    const results = new Map() as RawResult
    const options: SearchOptionsWithDefaults = { ...this._options.searchOptions, ...searchOptions }

    for (let shortId = 0; shortId < this._nextId; shortId++) {
      const id = this._externalIds[shortId]
      if (id === undefined) continue
      const score = options.boostDocument
        ? options.boostDocument(id, '', this._storedFields[shortId])
        : 1
      results.set(shortId, { score, terms: [], match: {} })
    }
    return results
  }
}
