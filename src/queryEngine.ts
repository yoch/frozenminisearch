import type { FrozenTermIndex } from './frozenTermIndex'
import {
  collectDocIdsFromFrozenLayout,
  type FrozenFieldTermFlyweight,
  type FrozenPostingsLayout,
} from './frozenPostings'
import {
  aggregateTerm,
  assertCombinationOperator,
  combineResults,
  fieldBoostsForQuery,
  type AggregateContext,
  type AggregateTermOptions,
  type DocIdGate,
  type DocIdSet,
  type FieldBoostsForQuery,
  type FieldTermDataLike,
  OR,
  type QuerySpec,
  type RawResult,
  termToQuerySpec,
} from './scoring'
import type {
  CombinationOperator,
  Query,
  QueryCombination,
  SearchOptions,
  SearchOptionsWithDefaults,
} from './searchTypes'
import { isWildcardQuery } from './symbols'
import { type QueryEngineRunOptions } from './queryEngineGateLimits'
import {
  collectAndDocIdsByEstimatedLength,
  collectCombinedDocIds,
  createDocIdSet,
  executeCombinedBranches,
} from './queryEngineGating'
import { DocIdBitSet } from './docIdBitSet'
import {
  estimateCheapTwoPhasePostingLengthForQuerySpec,
  estimateMaxPostingLengthForQuerySpec,
  forEachQuerySpecTermRef,
  type NormalizedStringQuery,
  visitQuerySpecForScoring,
} from './queryTermRefs'
import { defaultSearchOptions } from './searchDefaults'
import type { PackedTermCursor } from './PackedRadixTree/types'

/**
 * Adapter exposing packed frozen index storage to the shared query engine.
 * Accessors push prefix/fuzzy matches through visitors to avoid per-match
 * allocation on hot query paths.
 */
export interface QueryIndexView {
  getTermData(term: string): FieldTermDataLike | undefined
  /** Iterate over active documents (used by wildcard queries). */
  forEachActiveDoc(callback: (docId: number, externalId: unknown, storedFields?: Record<string, unknown>) => void): void
  /** Iterate over active document ids only, without reading stored fields. */
  forEachActiveDocId(callback: (docId: number) => void): void
  resolveTermIndex(term: string): number | undefined
  /**
   * Rebinds the instance flyweight; returned reference is valid only until the next
   * `fieldTermData` call or prefix/fuzzy iterator step on this view.
   */
  fieldTermData(termIndex: number): FieldTermDataLike
  collectDocIds(
    termIndex: number,
    fieldBoosts: FieldBoostsForQuery,
    context: AggregateContext,
    docIds: DocIdSet,
    allowedDocs?: DocIdGate,
  ): void
  visitPrefixMatchesByIndex(
    term: string,
    visit: (termIndex: number, length: number, cursor: PackedTermCursor) => void,
  ): void
  visitFuzzyMatchesByIndex(
    term: string,
    maxDistance: number,
    visit: (termIndex: number, length: number, distance: number, cursor: PackedTermCursor) => void,
  ): void
}

export interface QueryEngineParams {
  fields: string[]
  globalSearchOptions: SearchOptionsWithDefaults
  tokenize: (text: string, fieldName?: string) => string[]
  processTerm: (term: string, fieldName?: string) => string | string[] | null | undefined | false
  indexView: QueryIndexView
  aggregateContext: AggregateContext
  /** False for a search without match information: raw results leave `match` undefined. */
  trackMatch?: boolean
}

function useGatedEvaluation(
  run: QueryEngineRunOptions | undefined,
  branchCount: number,
  operator: CombinationOperator,
  hasWildcard: boolean,
): boolean {
  if (run?.disableGating) return false
  return shouldUseGatedEvaluation(branchCount, operator, hasWildcard)
}

function isQueryCombination(query: Query): query is QueryCombination {
  return typeof query === 'object'
    && query != null
    && 'queries' in query
    && Array.isArray((query as QueryCombination).queries)
}

function combinationHasWildcard(query: QueryCombination): boolean {
  return query.queries.some(q => isWildcardQuery(q) || (isQueryCombination(q) && combinationHasWildcard(q)))
}

function shouldUseGatedEvaluation(
  branchCount: number,
  operator: CombinationOperator,
  hasWildcard: boolean,
): boolean {
  if (hasWildcard) return false
  if (branchCount <= 1) return false
  const op = operator.toLowerCase()
  return op === 'and' || op === 'and_not'
}

function normalizeStringQuery(
  query: string,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): NormalizedStringQuery {
  const options = {
    tokenize: params.tokenize,
    processTerm: params.processTerm,
    ...params.globalSearchOptions,
    ...searchOptions,
  }
  const tokens = options.tokenize(query)
  const terms: string[] = []
  for (const token of tokens) {
    const processed = options.processTerm(token)
    if (Array.isArray(processed)) {
      for (const term of processed) {
        if (term) terms.push(term)
      }
    } else if (processed) {
      terms.push(processed)
    }
  }

  const toSpec = termToQuerySpec(options)
  const specs: QuerySpec[] = new Array(terms.length)
  for (let i = 0; i < terms.length; i++) {
    specs[i] = toSpec(terms[i], i, terms)
  }

  const { fuzzy: fuzzyWeight, prefix: prefixWeight } = {
    ...defaultSearchOptions.weights,
    ...options.weights,
  }

  return {
    options,
    specs,
    operator: options.combineWith ?? OR,
    fieldBoosts: fieldBoostsForQuery(options, params.fields),
    fuzzyWeight,
    prefixWeight,
  }
}

function executeQuerySpecInternal(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
): RawResult {
  const { fieldBoosts, options } = normalized
  const trackMatch = params.trackMatch !== false
  const termOptions: AggregateTermOptions | undefined = allowedDocs == null && trackMatch
    ? undefined
    : { allowedDocs, trackMatch }
  const results = new Map() as RawResult
  let derivedTermOrdinal = 0

  visitQuerySpecForScoring(query, normalized, params, (data, derivedTerm, termWeight) => {
    aggregateTerm(
      query.term,
      derivedTerm,
      termWeight,
      query.termBoost,
      data,
      fieldBoosts,
      params.aggregateContext,
      options.boostDocument,
      options.bm25,
      results,
      termOptions,
      derivedTermOrdinal++,
    )
  })

  return results
}

function estimateMaxPostingLengthForQuery(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): number {
  if (isWildcardQuery(query)) {
    return params.aggregateContext.documentCount
  }

  if (isQueryCombination(query)) {
    const options = { ...searchOptions, ...query, queries: undefined }
    let maxLen = 0
    for (const branch of query.queries) {
      maxLen = Math.max(maxLen, estimateMaxPostingLengthForQuery(branch, options, params))
    }
    return maxLen
  }

  if (typeof query !== 'string') return 0

  const normalized = normalizeStringQuery(query, searchOptions, params)
  let maxLen = 0
  for (const spec of normalized.specs) {
    maxLen = Math.max(maxLen, estimateMaxPostingLengthForQuerySpec(spec, normalized, params))
  }
  return maxLen
}

function collectDocIdsForQuerySpec(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
  newDocIdSet: () => DocIdSet = createDocIdSet,
): DocIdSet {
  const { fieldBoosts, options: { boostDocument } } = normalized
  const docIds = newDocIdSet()
  const { indexView, aggregateContext } = params
  let termDocIds: Set<number> | undefined

  forEachQuerySpecTermRef(query, normalized, params, (kind, termIndex, _length, _distance, cursor) => {
    if (termIndex == null) return
    if (boostDocument == null) {
      indexView.collectDocIds(termIndex, fieldBoosts, aggregateContext, docIds, allowedDocs)
      return
    }
    // Scoring drops docs whose boostDocument is 0 for this term, so membership must too.
    if (termDocIds == null) termDocIds = new Set<number>()
    else termDocIds.clear()
    indexView.collectDocIds(termIndex, fieldBoosts, aggregateContext, termDocIds, allowedDocs)
    if (termDocIds.size === 0) return
    const term = kind === 'exact' ? query.term : cursor?.term()
    if (term == null) return
    for (const docId of termDocIds) {
      if (docIds.has(docId)) continue
      if (boostDocument(aggregateContext.getExternalId(docId), term, aggregateContext.getStoredFields(docId))) {
        docIds.add(docId)
      }
    }
  })
  return docIds
}

/** Query adapter for packed frozen term indexes. */
export function createFrozenQueryIndexView(
  index: FrozenTermIndex,
  layout: FrozenPostingsLayout,
  flyweight: FrozenFieldTermFlyweight,
  forEachActiveDoc: QueryIndexView['forEachActiveDoc'],
  forEachActiveDocId: QueryIndexView['forEachActiveDocId'],
): QueryIndexView {
  return {
    resolveTermIndex(term) {
      const ti = index.get(term)
      return ti == null ? undefined : ti
    },
    fieldTermData(termIndex) {
      return flyweight.bind(termIndex)
    },
    collectDocIds(termIndex, fieldBoosts, context, docIds, allowedDocs) {
      collectDocIdsFromFrozenLayout(layout, termIndex, fieldBoosts, context, docIds, allowedDocs)
    },
    getTermData(term) {
      const ti = index.get(term)
      return ti == null ? undefined : flyweight.bind(ti)
    },
    visitPrefixMatchesByIndex(term, visit) {
      index.visitPrefixRefs(term, visit)
    },
    visitFuzzyMatchesByIndex(term, maxDistance, visit) {
      index.visitFuzzyRefs(term, maxDistance, visit)
    },
    forEachActiveDoc,
    forEachActiveDocId,
  }
}

function collectDocIdsForQueryInternal(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
  newDocIdSet: () => DocIdSet = createDocIdSet,
): DocIdSet {
  if (isWildcardQuery(query)) {
    const docIds = newDocIdSet()
    params.indexView.forEachActiveDocId((docId) => {
      if (allowedDocs != null && !allowedDocs.has(docId)) return
      docIds.add(docId)
    })
    return docIds
  }

  if (isQueryCombination(query)) {
    const options = { ...searchOptions, ...query, queries: undefined }
    const operator = options.combineWith ?? OR
    return collectCombinedDocIds(
      query.queries,
      operator,
      (branch, branchAllowed) => collectDocIdsForQueryInternal(branch, options, params, branchAllowed, newDocIdSet),
      allowedDocs,
      newDocIdSet,
    )
  }

  if (typeof query !== 'string') {
    throw new Error('FrozenMiniSearch: invalid query')
  }

  const normalized = normalizeStringQuery(query, searchOptions, params)
  const { specs, operator } = normalized

  if (specs.length === 0) return newDocIdSet()
  if (specs.length === 1) {
    // Scoring validates the operator of a single-term query too.
    assertCombinationOperator(operator)
    return collectDocIdsForQuerySpec(specs[0], normalized, params, allowedDocs, newDocIdSet)
  }

  const collectSpec = (spec: QuerySpec, branchAllowed?: DocIdGate) =>
    collectDocIdsForQuerySpec(spec, normalized, params, branchAllowed, newDocIdSet)
  if (operator.toLowerCase() === 'and') {
    // Start from the most selective exact terms, so a broad first term is only read under a gate.
    const lengths = specs.map(spec =>
      estimateCheapTwoPhasePostingLengthForQuerySpec(spec, normalized, params) ?? Number.MAX_SAFE_INTEGER)
    return collectAndDocIdsByEstimatedLength(specs, lengths, collectSpec, allowedDocs)
  }
  return collectCombinedDocIds(specs, operator, collectSpec, allowedDocs, newDocIdSet)
}

function executeWildcardQuery(
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  const results = new Map() as RawResult
  const options: SearchOptionsWithDefaults = { ...params.globalSearchOptions, ...searchOptions }
  const { boostDocument } = options
  const trackMatch = params.trackMatch !== false

  params.indexView.forEachActiveDoc((shortId, id, storedFields) => {
    const score = boostDocument ? boostDocument(id, '', storedFields) : 1
    results.set(shortId, { score, terms: [], match: trackMatch ? {} : undefined })
  })

  return results
}

function executeQueryInternal(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
  run?: QueryEngineRunOptions,
): RawResult {
  if (isWildcardQuery(query)) {
    return executeWildcardQuery(searchOptions, params)
  }

  if (isQueryCombination(query)) {
    // Spread inherits parent combineWith into child branches; global searchOptions do not apply (MiniSearch 7.2).
    const options = { ...searchOptions, ...query, queries: undefined }
    const operator = options.combineWith ?? OR

    if (useGatedEvaluation(run, query.queries.length, operator, combinationHasWildcard(query))) {
      return executeCombinedBranches(
        query.queries,
        operator,
        params,
        (branch, branchAllowed) => executeQueryInternal(branch, options, params, branchAllowed, run),
        (branch, branchAllowed) => collectDocIdsForQueryInternal(branch, options, params, branchAllowed),
        allowedDocs,
        run,
        branch => estimateMaxPostingLengthForQuery(branch, options, params),
      )
    }

    const results = query.queries.map(subquery =>
      executeQueryInternal(subquery, options, params, allowedDocs, run),
    )
    return combineResults(results, operator)
  }

  if (typeof query !== 'string') {
    throw new Error('FrozenMiniSearch: invalid query')
  }

  const normalized = normalizeStringQuery(query, searchOptions, params)
  const { specs, operator } = normalized

  if (useGatedEvaluation(run, specs.length, operator, false)) {
    return executeCombinedBranches(
      specs,
      operator,
      params,
      (spec, branchAllowed) => executeQuerySpecInternal(spec, normalized, params, branchAllowed),
      (spec, branchAllowed) => collectDocIdsForQuerySpec(spec, normalized, params, branchAllowed),
      allowedDocs,
      run,
      spec => estimateMaxPostingLengthForQuerySpec(spec, normalized, params),
      spec => estimateCheapTwoPhasePostingLengthForQuerySpec(spec, normalized, params),
    )
  }

  const results = specs.map(spec => executeQuerySpecInternal(spec, normalized, params, allowedDocs))
  return combineResults(results, operator)
}

/** @packageInternal Tests and benchmarks only. */
export function executeQueryWithRunOptions(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  run?: QueryEngineRunOptions,
): RawResult {
  return executeQueryInternal(query, searchOptions, params, undefined, run)
}

export function executeQuery(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  return executeQueryWithRunOptions(query, searchOptions, params)
}

/**
 * Short ids, in ascending order, of the documents matched by `query`, without scores or
 * match information: the documents of an unbounded, unfiltered search with the same options.
 * Collects into bitsets, which need no per-document allocation and no final sort.
 */
export function collectMatchingDocIds(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  docIdLimit: number,
): Uint32Array {
  const docIds = collectDocIdsForQueryInternal(
    query, searchOptions, params, undefined, () => new DocIdBitSet(docIdLimit),
  )
  // Every set comes from the factory above, so the result is a bitset.
  return (docIds as DocIdBitSet).toArray()
}
