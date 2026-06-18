import type { FrozenTermIndex } from './frozenTermIndex'
import {
  collectDocIdsFromFrozenLayout,
  type FrozenFieldTermFlyweight,
  type FrozenPostingsLayout,
} from './frozenPostings'
import {
  aggregateTerm,
  AND,
  combineResults,
  fieldBoostsForQuery,
  type AggregateContext,
  type AggregateDerivedTerm,
  type AggregateTermOptions,
  type DocIdGate,
  type FieldBoostsForQuery,
  type FieldTermDataLike,
  type QuerySpec,
  type RawResult,
  termToQuerySpec,
} from './scoring'
import { SegmentPostingList } from './compactPostings'
import { defaultSearchOptions } from './searchDefaults'
import type {
  CombinationOperator,
  Query,
  QueryCombination,
  SearchOptions,
  SearchOptionsWithDefaults,
} from './searchTypes'
import { isWildcardQuery } from './symbols'
import type { PackedFuzzyRef, PackedTermRef } from './PackedRadixTree/types'
import {
  gateIsSelectiveEnough,
  DEFAULT_POSTING_GATE_MIN_LENGTH,
  DEFAULT_POSTING_GATE_POLICY,
  DEFAULT_POSTING_GATE_RATIO_SHIFT,
  resolveGateMaxSize,
  shouldPassGateAsAllowedDocs,
  type QueryEngineRunOptions,
} from './queryEngineGateLimits'

/**
 * Adapter exposing packed frozen index storage to the shared query engine.
 * Accessors are lazy: prefix/fuzzy results are iterated only once by the engine.
 */
export interface QueryIndexView {
  getTermData(term: string): FieldTermDataLike | undefined
  /** Iterate over active documents (used by wildcard queries). */
  forEachActiveDoc(callback: (docId: number, externalId: unknown, storedFields?: Record<string, unknown>) => void): void
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
    docIds: Set<number>,
    allowedDocs?: DocIdGate,
  ): void
  getPrefixMatchesByIndex(term: string): Iterable<PackedTermRef>
  getFuzzyMatchesByIndex(term: string, maxDistance: number): Iterable<PackedFuzzyRef>
  resolveTermByIndex(termIndex: number): string
}

type NormalizedStringQuery = {
  options: SearchOptionsWithDefaults & Pick<QueryEngineParams, 'tokenize' | 'processTerm'>
  operator: CombinationOperator
  specs: QuerySpec[]
  fieldBoosts: FieldBoostsForQuery
  fuzzyWeight: number
  prefixWeight: number
}

export interface QueryEngineParams {
  fields: string[]
  globalSearchOptions: SearchOptionsWithDefaults
  tokenize: (text: string, fieldName?: string) => string[]
  processTerm: (term: string, fieldName?: string) => string | string[] | null | undefined | false
  indexView: QueryIndexView
  aggregateContext: AggregateContext
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

function gateFromResult(result: RawResult): DocIdGate {
  return {
    get size() {
      return result.size
    },
    has(docId) {
      return result.has(docId)
    },
    [Symbol.iterator]() {
      return result.keys()
    },
  }
}

function isQueryCombination(query: Query): query is QueryCombination {
  return typeof query === 'object'
    && query != null
    && 'queries' in query
    && Array.isArray((query as QueryCombination).queries)
}

function combinationHasWildcard(query: QueryCombination): boolean {
  return query.queries.some(q => isWildcardQuery(q) || (typeof q === 'object' && q != null && 'queries' in q && combinationHasWildcard(q)))
}

function isGatedCombinationOperator(operator: CombinationOperator): boolean {
  const op = operator.toLowerCase()
  return op === 'and' || op === 'and_not'
}

function shouldUseGatedEvaluation(
  branchCount: number,
  operator: CombinationOperator,
  hasWildcard: boolean,
): boolean {
  if (hasWildcard) return false
  if (branchCount <= 1) return false
  return isGatedCombinationOperator(operator)
}

function maxFuzzyDistance(query: QuerySpec, maxFuzzy: number): number {
  if (!query.fuzzy) return 0
  const fuzzy = (query.fuzzy === true) ? 0.2 : query.fuzzy
  return fuzzy < 1
    ? Math.min(maxFuzzy, Math.round(query.term.length * fuzzy))
    : fuzzy
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
    operator: options.combineWith as CombinationOperator,
    fieldBoosts: fieldBoostsForQuery(options, params.fields),
    fuzzyWeight,
    prefixWeight,
  }
}

function lazyIndexedTerm(
  indexView: QueryIndexView,
  termIndex: number,
): AggregateDerivedTerm {
  return { kind: 'lazy', resolve: () => indexView.resolveTermByIndex(termIndex) }
}

type QuerySpecTermRef
  = | { kind: 'exact', termIndex: number | undefined }
    | { kind: 'prefix', termIndex: number, length: number, distance: number }
    | { kind: 'fuzzy', termIndex: number, length: number, distance: number }

const TWO_PHASE_AND_NOT_MIN_FRACTION = 0.5

function forEachQuerySpecTermRef(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  visit: (ref: QuerySpecTermRef) => void,
): void {
  const { indexView } = params
  const { options } = normalized
  const maxDistance = maxFuzzyDistance(query, options.maxFuzzy)

  visit({ kind: 'exact', termIndex: indexView.resolveTermIndex(query.term) })

  const seenPrefix = query.prefix && maxDistance ? new Set<number>() : undefined
  if (query.prefix) {
    for (const { termIndex, length } of indexView.getPrefixMatchesByIndex(query.term)) {
      const distance = length - query.term.length
      if (!distance) continue
      seenPrefix?.add(termIndex)
      visit({ kind: 'prefix', termIndex, length, distance })
    }
  }
  if (!maxDistance) return
  for (const { termIndex, length, distance } of indexView.getFuzzyMatchesByIndex(query.term, maxDistance)) {
    if (!distance || seenPrefix?.has(termIndex)) continue
    visit({ kind: 'fuzzy', termIndex, length, distance })
  }
}

function visitQuerySpecForScoring(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  visit: (
    data: FieldTermDataLike | undefined,
    derivedTerm: AggregateDerivedTerm,
    termWeight: number,
  ) => void,
): void {
  const { indexView } = params
  const { fuzzyWeight, prefixWeight } = normalized

  forEachQuerySpecTermRef(query, normalized, params, (ref) => {
    if (ref.kind === 'exact') {
      visit(
        ref.termIndex == null ? undefined : indexView.fieldTermData(ref.termIndex),
        query.term,
        1,
      )
      return
    }
    if (ref.kind === 'prefix') {
      visit(
        indexView.fieldTermData(ref.termIndex),
        lazyIndexedTerm(indexView, ref.termIndex),
        prefixWeight * ref.length / (ref.length + 0.3 * ref.distance),
      )
      return
    }
    visit(
      indexView.fieldTermData(ref.termIndex),
      lazyIndexedTerm(indexView, ref.termIndex),
      fuzzyWeight * ref.length / (ref.length + ref.distance),
    )
  })
}

function executeQuerySpecInternal(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
): RawResult {
  const { fieldBoosts, options } = normalized
  const termOptions: AggregateTermOptions | undefined = allowedDocs == null ? undefined : { allowedDocs }
  const results = new Map() as RawResult

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
    )
  })

  return results
}

function maxPostingLengthForFieldTermData(
  data: FieldTermDataLike | undefined,
  fieldBoosts: FieldBoostsForQuery,
  fieldIds: AggregateContext['fieldIds'],
): number {
  if (data == null) return 0
  let maxLen = 0
  for (const field of fieldBoosts.names) {
    const fieldId = fieldIds[field]
    const postingList = data.get(fieldId)
    if (postingList == null) continue
    const len = postingList instanceof SegmentPostingList ? postingList.length : postingList.size
    if (len > maxLen) maxLen = len
  }
  return maxLen
}

function estimateMaxPostingLengthForQuerySpec(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
): number {
  const { indexView, aggregateContext } = params
  const { fieldBoosts } = normalized
  const { fieldIds } = aggregateContext

  let maxLen = 0
  const consider = (data: FieldTermDataLike | undefined) => {
    maxLen = Math.max(maxLen, maxPostingLengthForFieldTermData(data, fieldBoosts, fieldIds))
  }

  forEachQuerySpecTermRef(query, normalized, params, (ref) => {
    if (ref.kind === 'exact') {
      if (ref.termIndex != null) consider(indexView.fieldTermData(ref.termIndex))
      return
    }
    consider(indexView.fieldTermData(ref.termIndex))
  })
  return maxLen
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
): Set<number> {
  const { fieldBoosts } = normalized
  const docIds = new Set<number>()
  const { indexView, aggregateContext } = params

  forEachQuerySpecTermRef(query, normalized, params, (ref) => {
    if (ref.kind === 'exact') {
      if (ref.termIndex != null) {
        indexView.collectDocIds(ref.termIndex, fieldBoosts, aggregateContext, docIds, allowedDocs)
      }
      return
    }
    indexView.collectDocIds(ref.termIndex, fieldBoosts, aggregateContext, docIds, allowedDocs)
  })
  return docIds
}

function intersectDocIdsInPlace(docIds: Set<number>, branchDocIds: DocIdGate): void {
  for (const docId of docIds) {
    if (!branchDocIds.has(docId)) docIds.delete(docId)
  }
}

function subtractDocIdsInPlace(docIds: Set<number>, excludedDocIds: DocIdGate): void {
  for (const docId of excludedDocIds) docIds.delete(docId)
}

function subtractDocIdsFromResult(result: RawResult, excludedDocIds: DocIdGate): void {
  for (const docId of excludedDocIds) result.delete(docId)
}

function twoPhasePostingLengths<T>(
  branches: readonly T[],
  allowTwoPhase: boolean,
  estimateBranchPostingLength: ((branch: T) => number) | undefined,
): number[] | undefined {
  if (!allowTwoPhase || estimateBranchPostingLength == null) return undefined
  const lengths = new Array<number>(branches.length)
  for (let i = 0; i < branches.length; i++) {
    lengths[i] = estimateBranchPostingLength(branches[i])
  }
  return lengths
}

function shouldUseTwoPhaseAnd(
  branchPostingLengths: readonly number[],
  allowedDocs: DocIdGate | undefined,
): boolean {
  if (branchPostingLengths.length <= 1) return false

  const firstLength = branchPostingLengths[0]
  const effectiveFirstLength = allowedDocs == null
    ? firstLength
    : Math.min(firstLength, allowedDocs.size)
  if (effectiveFirstLength < DEFAULT_POSTING_GATE_MIN_LENGTH) return false

  const targetLength = effectiveFirstLength >>> DEFAULT_POSTING_GATE_RATIO_SHIFT
  for (let i = 1; i < branchPostingLengths.length; i++) {
    const len = branchPostingLengths[i]
    if (len > 0 && len <= targetLength) return true
  }
  return false
}

function shouldUseTwoPhaseAndNot(
  branchPostingLengths: readonly number[],
  allowedDocs: DocIdGate | undefined,
  documentCount: number,
): boolean {
  if (branchPostingLengths.length <= 1) return false

  const firstLength = branchPostingLengths[0]
  const effectiveFirstLength = allowedDocs == null
    ? firstLength
    : Math.min(firstLength, allowedDocs.size)
  const largeThreshold = Math.max(
    DEFAULT_POSTING_GATE_MIN_LENGTH,
    Math.floor(documentCount * TWO_PHASE_AND_NOT_MIN_FRACTION),
  )
  if (effectiveFirstLength < largeThreshold) return false

  for (let i = 1; i < branchPostingLengths.length; i++) {
    if (branchPostingLengths[i] >= largeThreshold) return true
  }
  return false
}

function executeAndWithFinalGate<T>(
  branches: readonly T[],
  finalGate: Set<number>,
  executeBranch: (branch: T, allowedDocs?: DocIdGate) => RawResult,
): RawResult {
  if (finalGate.size === 0) return new Map()

  let result = executeBranch(branches[0], finalGate)
  for (let i = 1; i < branches.length; i++) {
    if (result.size === 0) return result
    result = combineResults([result, executeBranch(branches[i], finalGate)], AND)
  }
  return result
}

function collectAndDocIdsByEstimatedLength<T>(
  branches: readonly T[],
  branchPostingLengths: readonly number[],
  collectBranch: (branch: T, allowedDocs?: DocIdGate) => Set<number>,
  allowedDocs?: DocIdGate,
): Set<number> {
  const order = branches.map((_, i) => i)
  order.sort((a, b) => branchPostingLengths[a] - branchPostingLengths[b] || a - b)

  const docIds = collectBranch(branches[order[0]], allowedDocs)
  for (let i = 1; i < order.length; i++) {
    if (docIds.size === 0) return docIds
    intersectDocIdsInPlace(docIds, collectBranch(branches[order[i]], docIds))
  }
  return docIds
}

function collectCombinedDocIds<T>(
  branches: readonly T[],
  operator: CombinationOperator,
  collectBranch: (branch: T, allowedDocs?: DocIdGate) => Set<number>,
  allowedDocs?: DocIdGate,
): Set<number> {
  if (branches.length === 0) return new Set()

  const op = operator.toLowerCase()
  if (op === 'or') {
    const docIds = new Set<number>()
    for (const branch of branches) {
      for (const docId of collectBranch(branch, allowedDocs)) {
        docIds.add(docId)
      }
    }
    return docIds
  }

  const docIds = collectBranch(branches[0], allowedDocs)
  if (op === 'and') {
    for (let i = 1; i < branches.length; i++) {
      intersectDocIdsInPlace(docIds, collectBranch(branches[i], docIds))
    }
    return docIds
  }

  if (op === 'and_not') {
    for (let i = 1; i < branches.length; i++) {
      subtractDocIdsInPlace(docIds, collectBranch(branches[i], docIds))
    }
    return docIds
  }

  throw new Error(`Invalid combination operator: ${operator}`)
}

/**
 * AND: normally score left-to-right with optional docId gates; for broad-first selective
 * exact queries, collect the final gate first, then score branches in original order.
 * AND_NOT: score the positive branch only; negated branches are collected as docId sets and
 * subtracted without scoring. Large exact exclusions may collect survivors before positive scoring.
 */
function executeCombinedBranches<T>(
  branches: readonly T[],
  operator: CombinationOperator,
  params: QueryEngineParams,
  executeBranch: (branch: T, allowedDocs?: DocIdGate) => RawResult,
  collectBranch: (branch: T, allowedDocs?: DocIdGate) => Set<number>,
  allowedDocs?: DocIdGate,
  run?: QueryEngineRunOptions,
  estimateBranchPostingLength?: (branch: T) => number,
  allowTwoPhase = false,
): RawResult {
  if (branches.length === 0) return new Map()

  const op = operator.toLowerCase()
  if (op === 'or') {
    return combineResults(
      branches.map(branch => executeBranch(branch, allowedDocs)),
      operator,
    )
  }

  if (op === 'and') {
    const branchPostingLengths = twoPhasePostingLengths(branches, allowTwoPhase, estimateBranchPostingLength)
    if (branchPostingLengths != null && shouldUseTwoPhaseAnd(branchPostingLengths, allowedDocs)) {
      const finalGate = collectAndDocIdsByEstimatedLength(
        branches,
        branchPostingLengths,
        collectBranch,
        allowedDocs,
      )
      return executeAndWithFinalGate(branches, finalGate, executeBranch)
    }

    let result = executeBranch(branches[0], allowedDocs)
    let gate = gateFromResult(result)
    const limits = run?.gateLimits
    const documentCount = params.aggregateContext.documentCount
    const postingGatePolicy = run?.postingGatePolicy ?? DEFAULT_POSTING_GATE_POLICY
    const maxGateSize = resolveGateMaxSize(documentCount, limits)
    for (let i = 1; i < branches.length; i++) {
      if (gate.size === 0) return result

      const absoluteSelective = gate.size <= maxGateSize
      const postingListLength = absoluteSelective
        ? undefined
        : estimateBranchPostingLength?.(branches[i])

      const selective = gateIsSelectiveEnough(
        gate.size,
        documentCount,
        limits,
        postingListLength,
        postingGatePolicy,
      )
      const branchAllowed = absoluteSelective || shouldPassGateAsAllowedDocs(selective, gate.size, postingListLength)
        ? gate
        : allowedDocs
      result = combineResults([result, executeBranch(branches[i], branchAllowed)], AND)
      gate = gateFromResult(result)
    }
    return result
  }

  if (op === 'and_not') {
    const branchPostingLengths = twoPhasePostingLengths(branches, allowTwoPhase, estimateBranchPostingLength)
    if (branchPostingLengths != null && shouldUseTwoPhaseAndNot(
      branchPostingLengths,
      allowedDocs,
      params.aggregateContext.documentCount,
    )) {
      const finalGate = collectCombinedDocIds(
        branches,
        operator,
        collectBranch,
        allowedDocs,
      )
      return finalGate.size === 0 ? new Map() : executeBranch(branches[0], finalGate)
    }

    const result = executeBranch(branches[0], allowedDocs)
    let gate = gateFromResult(result)
    for (let i = 1; i < branches.length; i++) {
      subtractDocIdsFromResult(result, collectBranch(branches[i], gate))
      gate = gateFromResult(result)
    }
    return result
  }

  throw new Error(`Invalid combination operator: ${operator}`)
}

/** Query adapter for packed frozen term indexes. */
export function createFrozenQueryIndexView(
  index: FrozenTermIndex,
  layout: FrozenPostingsLayout,
  flyweight: FrozenFieldTermFlyweight,
  forEachActiveDoc: QueryIndexView['forEachActiveDoc'],
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
    * getPrefixMatchesByIndex(term) {
      yield* index.prefixRefs(term)
    },
    * getFuzzyMatchesByIndex(term, maxDistance) {
      yield* index.fuzzyRefs(term, maxDistance)
    },
    resolveTermByIndex(termIndex) {
      return index.termByIndex(termIndex)
    },
    forEachActiveDoc,
  }
}

function collectDocIdsForQueryInternal(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: DocIdGate,
): Set<number> {
  if (isWildcardQuery(query)) {
    const docIds = new Set<number>()
    params.indexView.forEachActiveDoc((docId) => {
      if (allowedDocs != null && !allowedDocs.has(docId)) return
      docIds.add(docId)
    })
    return docIds
  }

  if (isQueryCombination(query)) {
    const options = { ...searchOptions, ...query, queries: undefined }
    const operator = (
      query.combineWith
      ?? options.combineWith
      ?? params.globalSearchOptions.combineWith
    ) as CombinationOperator
    return collectCombinedDocIds(
      query.queries,
      operator,
      (branch, branchAllowed) => collectDocIdsForQueryInternal(branch, options, params, branchAllowed),
      allowedDocs,
    )
  }

  if (typeof query !== 'string') {
    throw new Error('FrozenMiniSearch: invalid query')
  }

  const normalized = normalizeStringQuery(query, searchOptions, params)
  const { specs, operator } = normalized
  const combineWith = (operator ?? params.globalSearchOptions.combineWith) as CombinationOperator

  if (specs.length <= 1) {
    return specs.length === 1
      ? collectDocIdsForQuerySpec(specs[0], normalized, params, allowedDocs)
      : new Set<number>()
  }

  return collectCombinedDocIds(
    specs,
    combineWith,
    (spec, branchAllowed) => collectDocIdsForQuerySpec(spec, normalized, params, branchAllowed),
    allowedDocs,
  )
}

function executeWildcardQuery(
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  const results = new Map() as RawResult
  const options: SearchOptionsWithDefaults = { ...params.globalSearchOptions, ...searchOptions }
  const { boostDocument } = options

  params.indexView.forEachActiveDoc((shortId, id, storedFields) => {
    const score = boostDocument ? boostDocument(id, '', storedFields) : 1
    results.set(shortId, { score, terms: [], match: {} })
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
    // Spread inherits parent combineWith into child branches (MiniSearch 7.2 behavior).
    const options = { ...searchOptions, ...query, queries: undefined }
    const operator = (
      query.combineWith
      ?? options.combineWith
      ?? params.globalSearchOptions.combineWith
    ) as CombinationOperator

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
  const combineWith = (operator ?? params.globalSearchOptions.combineWith) as CombinationOperator

  if (useGatedEvaluation(run, specs.length, combineWith, false)) {
    return executeCombinedBranches(
      specs,
      combineWith,
      params,
      (spec, branchAllowed) => executeQuerySpecInternal(spec, normalized, params, branchAllowed),
      (spec, branchAllowed) => collectDocIdsForQuerySpec(spec, normalized, params, branchAllowed),
      allowedDocs,
      run,
      spec => estimateMaxPostingLengthForQuerySpec(spec, normalized, params),
      specs.every(spec => !spec.prefix && !spec.fuzzy),
    )
  }

  const results = specs.map(spec => executeQuerySpecInternal(spec, normalized, params, allowedDocs))
  return combineResults(results, combineWith)
}

export function executeQuery(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  return executeQueryInternal(query, searchOptions, params)
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
