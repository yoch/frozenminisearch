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
  type QuerySpec
} from './scoring'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions
} from './searchDefaults'
import {
  compactPostingFromMap,
  compactFieldTermDataAdapter,
  type CompactFieldTermData
} from './compactPostings'
import { decodeFrozenSnapshot, encodeFrozenSnapshot, type TreeShape } from './binaryFormat'
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

function toCompactFieldData (
  fieldIndex: Map<number, Map<number, number>>,
  fieldCount: number
): CompactFieldTermData {
  const byField: (ReturnType<typeof compactPostingFromMap> | undefined)[] = new Array(fieldCount)
  const matchingFieldsByField = new Uint32Array(fieldCount)
  for (const [fieldId, freqs] of fieldIndex) {
    byField[fieldId] = compactPostingFromMap(freqs)
    matchingFieldsByField[fieldId] = freqs.size
  }
  return { byField, matchingFieldsByField }
}

/** Clone radix tree preserving Map key insertion order (required for prefix/fuzzy parity). */
function cloneRadixTreeWithCompact (
  tree: RadixTree<Map<number, Map<number, number>>>,
  fieldCount: number
): RadixTree<CompactFieldTermData> {
  const out = new Map() as RadixTree<CompactFieldTermData>
  for (const [key, val] of tree) {
    if (key === LEAF) {
      out.set(LEAF, toCompactFieldData(val as Map<number, Map<number, number>>, fieldCount))
    } else {
      out.set(key, cloneRadixTreeWithCompact(val as RadixTree<Map<number, Map<number, number>>>, fieldCount))
    }
  }
  return out
}

function serializeCompactTree (
  tree: RadixTree<CompactFieldTermData>,
  postingIndexes: WeakMap<CompactFieldTermData, number>
): TreeShape {
  const shape: TreeShape = []
  for (const [key, val] of tree) {
    if (key === LEAF) {
      const postingIndex = postingIndexes.get(val as CompactFieldTermData)
      if (postingIndex == null) {
        throw new Error('FrozenMiniSearch: missing posting index while serializing tree')
      }
      shape.push([key, postingIndex])
    } else {
      shape.push([key, serializeCompactTree(val as RadixTree<CompactFieldTermData>, postingIndexes)])
    }
  }
  return shape
}

function deserializeCompactTree (
  shape: TreeShape,
  postingsByTerm: CompactFieldTermData[]
): RadixTree<CompactFieldTermData> {
  const tree = new Map() as RadixTree<CompactFieldTermData>
  for (const [key, value] of shape) {
    if (key === LEAF) {
      tree.set(LEAF, postingsByTerm[value as number])
    } else {
      tree.set(key, deserializeCompactTree(value as TreeShape, postingsByTerm))
    }
  }
  return tree
}

function throwReadOnly (): never {
  throw new Error(READ_ONLY_MSG)
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

export function freezeFromMiniSearch<T> (source: FreezeSource<T>): FrozenMiniSearch<T> {
  const fieldCount = source._options.fields.length
  const { _nextId, _documentCount } = source

  const externalIds: unknown[] = new Array(_nextId)
  const idToShortId = new Map<unknown, number>()
  const storedFields: (Record<string, unknown> | undefined)[] = new Array(_nextId)
  for (const [shortId, id] of source._documentIds) {
    externalIds[shortId] = id
    idToShortId.set(id, shortId)
    storedFields[shortId] = source._storedFields.get(shortId)
  }

  const fieldLengthMatrix = new Uint32Array(_nextId * fieldCount)
  for (const [shortId, lengths] of source._fieldLength) {
    for (let f = 0; f < fieldCount; f++) {
      fieldLengthMatrix[shortId * fieldCount + f] = lengths[f] ?? 0
    }
  }

  const avgFieldLength = new Float32Array(source._avgFieldLength.length)
  for (let i = 0; i < source._avgFieldLength.length; i++) {
    avgFieldLength[i] = source._avgFieldLength[i]
  }

  const frozenTree = cloneRadixTreeWithCompact(
    source._index.radixTree as RadixTree<Map<number, Map<number, number>>>,
    fieldCount
  )
  const frozenIndex = new SearchableMap<CompactFieldTermData>(frozenTree)

  const terms: string[] = []
  const postingsByTerm: CompactFieldTermData[] = []
  for (const [term, compact] of frozenIndex) {
    terms.push(term)
    postingsByTerm.push(compact)
  }

  return new FrozenMiniSearch({
    options: source._options,
    documentCount: _documentCount,
    nextId: _nextId,
    fieldIds: source._fieldIds,
    fieldCount,
    externalIds,
    idToShortId,
    storedFields,
    fieldLengthMatrix,
    avgFieldLength,
    index: frozenIndex,
    terms,
    postingsByTerm
  })
}

export default class FrozenMiniSearch<T = any> {
  private readonly _options: OptionsWithDefaults<T>
  private readonly _index: SearchableMap<CompactFieldTermData>
  private readonly _documentCount: number
  private readonly _nextId: number
  private readonly _externalIds: unknown[]
  private readonly _idToShortId: Map<unknown, number>
  private readonly _fieldIds: { [key: string]: number }
  private readonly _fieldCount: number
  private readonly _fieldLengthMatrix: Uint32Array
  private readonly _avgFieldLength: Float32Array
  private readonly _storedFields: (Record<string, unknown> | undefined)[]
  private readonly _terms: string[]
  private readonly _postingsByTerm: CompactFieldTermData[]

  constructor (params: {
    options: OptionsWithDefaults<T>
    documentCount: number
    nextId: number
    fieldIds: { [key: string]: number }
    fieldCount: number
    externalIds: unknown[]
    idToShortId: Map<unknown, number>
    storedFields: (Record<string, unknown> | undefined)[]
    fieldLengthMatrix: Uint32Array
    avgFieldLength: Float32Array
    index: SearchableMap<CompactFieldTermData>
    terms: string[]
    postingsByTerm: CompactFieldTermData[]
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
    this._postingsByTerm = params.postingsByTerm
  }

  static readonly wildcard: typeof WILDCARD_QUERY = WILDCARD_QUERY

  get documentCount (): number { return this._documentCount }
  get termCount (): number { return this._index.size }

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

  /**
   * Serialize this frozen index to a compact binary buffer ({@link FrozenMiniSearch.loadBinary}).
   */
  saveBinary (): Buffer {
    const postingIndexes = new WeakMap<CompactFieldTermData, number>()
    for (let i = 0; i < this._postingsByTerm.length; i++) {
      postingIndexes.set(this._postingsByTerm[i], i)
    }

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
      postingsByTerm: this._postingsByTerm,
      treeShape: serializeCompactTree(this._index.radixTree, postingIndexes)
    })
  }

  /**
   * Load a frozen index from {@link saveBinary}. Pass the same `fields` (and ideally
   * the same `tokenize` / `processTerm`) used when the index was built.
   */
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

    const index = new SearchableMap<CompactFieldTermData>(
      deserializeCompactTree(snap.treeShape, snap.postingsByTerm)
    )

    const idToShortId = new Map<unknown, number>()
    for (let i = 0; i < snap.externalIds.length; i++) {
      if (snap.externalIds[i] !== undefined) {
        idToShortId.set(snap.externalIds[i], i)
      }
    }

    return new FrozenMiniSearch({
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
      postingsByTerm: snap.postingsByTerm
    })
  }

  private getFieldLength (docId: number, fieldId: number): number {
    return this._fieldLengthMatrix[docId * this._fieldCount + fieldId] ?? 0
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
    fieldTermData: CompactFieldTermData | undefined,
    fieldBoosts: { [field: string]: number },
    boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,
    bm25params: BM25Params,
    results: RawResult = new Map()
  ): RawResult {
    return aggregateTerm(
      sourceTerm,
      derivedTerm,
      termWeight,
      termBoost,
      fieldTermData == null ? undefined : compactFieldTermDataAdapter(fieldTermData),
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

    const data = this._index.get(query.term)
    const results = this.termResults(query.term, query.term, 1, query.termBoost, data, boosts, boostDocument, bm25params)

    let prefixMatches
    let fuzzyMatches

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
      for (const [term, pdata] of prefixMatches) {
        const distance = term.length - query.term.length
        if (!distance) continue
        fuzzyMatches?.delete(term)
        const weight = prefixWeight * term.length / (term.length + 0.3 * distance)
        this.termResults(query.term, term, weight, query.termBoost, pdata, boosts, boostDocument, bm25params, results)
      }
    }

    if (fuzzyMatches) {
      for (const term of fuzzyMatches.keys()) {
        const [pdata, distance] = fuzzyMatches.get(term)!
        if (!distance) continue
        const weight = fuzzyWeight * term.length / (term.length + distance)
        this.termResults(query.term, term, weight, query.termBoost, pdata, boosts, boostDocument, bm25params, results)
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
