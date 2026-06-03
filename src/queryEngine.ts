import SearchableMap from './SearchableMap/SearchableMap'
import type { FrozenTermIndex } from './frozenTermIndex'
import {
  aggregateTerm,
  AND,
  collectDocIdsFromFieldTermData,
  combineResults,
  fieldBoostsForQuery,
  termToQuerySpec,
  type AggregateContext,
  type AggregateDerivedTerm,
  type AggregateTermOptions,
  type FieldTermDataLike,
  type QuerySpec,
  type RawResult,
} from './scoring'
import { defaultSearchOptions } from './searchDefaults'
import type {
  CombinationOperator,
  Query,
  QueryCombination,
  SearchOptions,
  SearchOptionsWithDefaults,
} from './searchTypes'
import { WILDCARD_QUERY } from './symbols'
import type { PackedFuzzyRef, PackedTermRef } from './PackedRadixTree/types'

/**
 * Adapter exposing the index storage (mutable maps or frozen flat arrays) to the
 * shared query engine. All accessors are lazy: prefix/fuzzy results are iterated
 * only once by the engine, so wrappers should be allocated on demand.
 */
interface BaseQueryIndexView {
  getTermData(term: string): FieldTermDataLike | undefined
  /** Iterate over active documents (used by wildcard queries). */
  forEachActiveDoc(callback: (docId: number, externalId: unknown, storedFields?: Record<string, unknown>) => void): void
}

interface StringQueryIndexView extends BaseQueryIndexView {
  mode: 'string'
  /** Iterable of (term, data) for terms sharing the prefix. May be undefined when prefix search is not requested. */
  getPrefixMatches(term: string): Iterable<[string, FieldTermDataLike]> | undefined
  /** Map keyed by term; must support `.delete(term)` so the engine can drop fuzzy duplicates of prefix hits. */
  getFuzzyMatches(
    term: string,
    maxDistance: number,
  ): Map<string, { data: FieldTermDataLike, distance: number }> | undefined
}

interface IndexedQueryIndexView extends BaseQueryIndexView {
  mode: 'indexed'
  getPrefixMatchesByIndex(term: string): Iterable<PackedTermRef & { data: FieldTermDataLike }>
  getFuzzyMatchesByIndex(term: string, maxDistance: number): Iterable<PackedFuzzyRef & { data: FieldTermDataLike }>
  resolveTermByIndex(termIndex: number): string
}

type NormalizedStringQuery = {
  options: SearchOptionsWithDefaults & Pick<QueryEngineParams, 'tokenize' | 'processTerm'>
  operator: CombinationOperator
  specs: QuerySpec[]
}

type DerivedMatch = {
  data: FieldTermDataLike | undefined
  derivedTerm: AggregateDerivedTerm
  termWeight: number
}

export type QueryIndexView = StringQueryIndexView | IndexedQueryIndexView

export interface QueryEngineParams {
  fields: string[]
  globalSearchOptions: SearchOptionsWithDefaults
  tokenize: (text: string, fieldName?: string) => string[]
  processTerm: (term: string, fieldName?: string) => string | string[] | null | undefined | false
  indexView: QueryIndexView
  aggregateContext: AggregateContext
}

/** Max intersection size for AND branch gating; above this, score full branch then combine. */
const AND_GATE_MAX_ABSOLUTE = 5000
const AND_GATE_MAX_FRACTION = 0.1

function eagerDerivedTerm(term: string): AggregateDerivedTerm {
  return { kind: 'eager', term }
}

function lazyDerivedTerm(resolve: () => string): AggregateDerivedTerm {
  return { kind: 'lazy', resolve }
}

function docIdsFromResult(result: RawResult): Set<number> {
  return new Set(result.keys())
}

function isWildcardQuery(query: Query): boolean {
  if (query === WILDCARD_QUERY) return true
  if (typeof query === 'string') return false
  return query.queries.some(isWildcardQuery)
}

function shouldUseGatedEvaluation(
  params: QueryEngineParams,
  branchCount: number,
  operator: CombinationOperator,
  hasWildcard: boolean,
): boolean {
  if (hasWildcard) return false
  if (params.indexView.mode !== 'indexed') return false
  if (branchCount <= 1) return false
  const op = operator.toLowerCase()
  return op === 'and' || op === 'and_not'
}

function shouldGateAndBranch(gate: Set<number>, documentCount: number): boolean {
  if (gate.size === 0) return true
  const maxSize = Math.min(
    AND_GATE_MAX_ABSOLUTE,
    Math.max(100, Math.floor(documentCount * AND_GATE_MAX_FRACTION)),
  )
  return gate.size <= maxSize
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
  const terms = options.tokenize(query)
    .flatMap((term: string) => options.processTerm(term))
    .filter(term => !!term) as string[]
  return {
    options,
    specs: terms.map(termToQuerySpec(options)),
    operator: options.combineWith as CombinationOperator,
  }
}

function visitQuerySpecMatches(
  query: QuerySpec,
  options: SearchOptionsWithDefaults,
  params: QueryEngineParams,
  useLazyIndexedTerms: boolean,
  visit: (match: DerivedMatch) => void,
): void {
  const { indexView } = params
  const { weights, maxFuzzy } = options
  const { fuzzy: fuzzyWeight, prefix: prefixWeight } = { ...defaultSearchOptions.weights, ...weights }
  const maxDistance = maxFuzzyDistance(query, maxFuzzy)

  visit({
    data: indexView.getTermData(query.term),
    derivedTerm: eagerDerivedTerm(query.term),
    termWeight: 1,
  })

  if (indexView.mode === 'indexed') {
    const seenPrefix = new Set<number>()
    if (query.prefix) {
      for (const { termIndex, length, data } of indexView.getPrefixMatchesByIndex(query.term)) {
        const distance = length - query.term.length
        if (!distance) continue
        seenPrefix.add(termIndex)
        visit({
          data,
          derivedTerm: useLazyIndexedTerms
            ? lazyDerivedTerm(() => indexView.resolveTermByIndex(termIndex))
            : eagerDerivedTerm(indexView.resolveTermByIndex(termIndex)),
          termWeight: prefixWeight * length / (length + 0.3 * distance),
        })
      }
    }
    if (!maxDistance) return
    for (const { termIndex, length, data, distance } of indexView.getFuzzyMatchesByIndex(query.term, maxDistance)) {
      if (!distance || seenPrefix.has(termIndex)) continue
      visit({
        data,
        derivedTerm: useLazyIndexedTerms
          ? lazyDerivedTerm(() => indexView.resolveTermByIndex(termIndex))
          : eagerDerivedTerm(indexView.resolveTermByIndex(termIndex)),
        termWeight: fuzzyWeight * length / (length + distance),
      })
    }
    return
  }

  const prefixMatches = query.prefix ? indexView.getPrefixMatches(query.term) : undefined
  const fuzzyMatches = maxDistance ? indexView.getFuzzyMatches(query.term, maxDistance) : undefined

  if (prefixMatches) {
    for (const [term, data] of prefixMatches) {
      const distance = term.length - query.term.length
      if (!distance) continue
      fuzzyMatches?.delete(term)
      visit({
        data,
        derivedTerm: eagerDerivedTerm(term),
        termWeight: prefixWeight * term.length / (term.length + 0.3 * distance),
      })
    }
  }

  if (!fuzzyMatches) return
  for (const [term, { data, distance }] of fuzzyMatches) {
    if (!distance) continue
    visit({
      data,
      derivedTerm: eagerDerivedTerm(term),
      termWeight: fuzzyWeight * term.length / (term.length + distance),
    })
  }
}

function executeQuerySpecInternal(
  query: QuerySpec,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: Set<number>,
): RawResult {
  const options: SearchOptionsWithDefaults = { ...params.globalSearchOptions, ...searchOptions }
  const fieldBoosts = fieldBoostsForQuery(options, params.fields)
  const termOptions: AggregateTermOptions | undefined = allowedDocs == null ? undefined : { allowedDocs }
  const results = new Map() as RawResult

  visitQuerySpecMatches(query, options, params, allowedDocs != null, ({ data, derivedTerm, termWeight }) => {
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

function collectDocIdsForQuerySpec(
  query: QuerySpec,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: Set<number>,
): Set<number> {
  const options: SearchOptionsWithDefaults = { ...params.globalSearchOptions, ...searchOptions }
  const fieldBoosts = fieldBoostsForQuery(options, params.fields)
  const docIds = new Set<number>()

  visitQuerySpecMatches(query, options, params, false, ({ data }) => {
    collectDocIdsFromFieldTermData(
      data,
      fieldBoosts,
      params.aggregateContext,
      docIds,
      allowedDocs,
    )
  })

  return docIds
}

function collectCombinedDocIds<T>(
  branches: readonly T[],
  operator: CombinationOperator,
  collectBranch: (branch: T, allowedDocs?: Set<number>) => Set<number>,
  allowedDocs?: Set<number>,
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
      const branchDocIds = collectBranch(branches[i], docIds)
      for (const docId of docIds) {
        if (!branchDocIds.has(docId)) docIds.delete(docId)
      }
    }
    return docIds
  }

  if (op === 'and_not') {
    for (let i = 1; i < branches.length; i++) {
      const excludedDocIds = collectBranch(branches[i], docIds)
      for (const docId of excludedDocIds) docIds.delete(docId)
    }
    return docIds
  }

  throw new Error(`Invalid combination operator: ${operator}`)
}

function executeCombinedBranches<T>(
  branches: readonly T[],
  operator: CombinationOperator,
  params: QueryEngineParams,
  executeBranch: (branch: T, allowedDocs?: Set<number>) => RawResult,
  collectBranch: (branch: T, allowedDocs?: Set<number>) => Set<number>,
  allowedDocs?: Set<number>,
): RawResult {
  if (branches.length === 0) return new Map()

  const op = operator.toLowerCase()
  if (op === 'or') {
    return combineResults(
      branches.map(branch => executeBranch(branch, allowedDocs)),
      operator,
    )
  }

  let result = executeBranch(branches[0], allowedDocs)
  let gate = docIdsFromResult(result)

  if (op === 'and') {
    for (let i = 1; i < branches.length; i++) {
      const branchAllowed = shouldGateAndBranch(gate, params.aggregateContext.documentCount)
        ? gate
        : allowedDocs
      result = combineResults([result, executeBranch(branches[i], branchAllowed)], AND)
      gate = docIdsFromResult(result)
    }
    return result
  }

  if (op === 'and_not') {
    for (let i = 1; i < branches.length; i++) {
      const excludedDocIds = collectBranch(branches[i], gate)
      for (const docId of excludedDocIds) result.delete(docId)
      gate = docIdsFromResult(result)
    }
    return result
  }

  throw new Error(`Invalid combination operator: ${operator}`)
}

/** Query adapter for packed frozen term indexes. */
export function createFrozenQueryIndexView(
  index: FrozenTermIndex,
  fieldTermDataFor: (termIndex: number) => FieldTermDataLike,
  forEachActiveDoc: QueryIndexView['forEachActiveDoc'],
): QueryIndexView {
  return {
    mode: 'indexed',
    getTermData(term) {
      const ti = index.get(term)
      return ti == null ? undefined : fieldTermDataFor(ti)
    },
    * getPrefixMatchesByIndex(term) {
      for (const { termIndex, length } of index.prefixRefs(term)) {
        yield { termIndex, length, data: fieldTermDataFor(termIndex) }
      }
    },
    * getFuzzyMatchesByIndex(term, maxDistance) {
      for (const { termIndex, length, distance } of index.fuzzyRefs(term, maxDistance)) {
        yield { termIndex, length, distance, data: fieldTermDataFor(termIndex) }
      }
    },
    resolveTermByIndex(termIndex) {
      return index.termByIndex(termIndex)
    },
    forEachActiveDoc,
  }
}

/** Shared radix-index adapter for mutable and frozen query paths. */
export function createQueryIndexView<L>(
  index: SearchableMap<L>,
  toFieldTermData: (leaf: L) => FieldTermDataLike,
  forEachActiveDoc: QueryIndexView['forEachActiveDoc'],
): QueryIndexView {
  return {
    mode: 'string',
    getTermData(term) {
      const leaf = index.get(term)
      return leaf == null ? undefined : toFieldTermData(leaf)
    },
    * getPrefixMatches(term) {
      for (const [t, leaf] of index.atPrefix(term)) {
        yield [t, toFieldTermData(leaf)]
      }
    },
    getFuzzyMatches(term, maxDistance) {
      const matches = index.fuzzyGet(term, maxDistance)
      if (matches == null) return undefined
      const out = new Map<string, { data: FieldTermDataLike, distance: number }>()
      for (const [t, [leaf, distance]] of matches) {
        out.set(t, { data: toFieldTermData(leaf), distance })
      }
      return out
    },
    forEachActiveDoc,
  }
}

function collectDocIdsForQueryInternal(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
  allowedDocs?: Set<number>,
): Set<number> {
  if (query === WILDCARD_QUERY) {
    const docIds = new Set<number>()
    params.indexView.forEachActiveDoc((docId) => {
      if (allowedDocs != null && !allowedDocs.has(docId)) return
      docIds.add(docId)
    })
    return docIds
  }

  if (typeof query !== 'string') {
    const combination = query as QueryCombination
    const options = { ...searchOptions, ...combination, queries: undefined }
    return collectCombinedDocIds(
      combination.queries,
      options.combineWith as CombinationOperator,
      (branch, branchAllowed) => collectDocIdsForQueryInternal(branch, options, params, branchAllowed),
      allowedDocs,
    )
  }

  const { options, specs, operator } = normalizeStringQuery(query, searchOptions, params)

  if (specs.length <= 1) {
    return specs.length === 1
      ? collectDocIdsForQuerySpec(specs[0], options, params, allowedDocs)
      : new Set<number>()
  }

  return collectCombinedDocIds(
    specs,
    operator,
    (spec, branchAllowed) => collectDocIdsForQuerySpec(spec, options, params, branchAllowed),
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
  allowedDocs?: Set<number>,
): RawResult {
  if (query === WILDCARD_QUERY) {
    return executeWildcardQuery(searchOptions, params)
  }

  if (typeof query !== 'string') {
    const combination = query as QueryCombination
    const options = { ...searchOptions, ...combination, queries: undefined }
    const operator = options.combineWith as CombinationOperator

    if (shouldUseGatedEvaluation(params, combination.queries.length, operator, isWildcardQuery(query))) {
      return executeCombinedBranches(
        combination.queries,
        operator,
        params,
        (branch, branchAllowed) => executeQueryInternal(branch, options, params, branchAllowed),
        (branch, branchAllowed) => collectDocIdsForQueryInternal(branch, options, params, branchAllowed),
        allowedDocs,
      )
    }

    const results = combination.queries.map(subquery =>
      executeQueryInternal(subquery, options, params, allowedDocs),
    )
    return combineResults(results, operator)
  }

  const { options, specs, operator } = normalizeStringQuery(query, searchOptions, params)

  if (shouldUseGatedEvaluation(params, specs.length, operator, false)) {
    return executeCombinedBranches(
      specs,
      operator,
      params,
      (spec, branchAllowed) => executeQuerySpecInternal(spec, options, params, branchAllowed),
      (spec, branchAllowed) => collectDocIdsForQuerySpec(spec, options, params, branchAllowed),
      allowedDocs,
    )
  }

  const results = specs.map(spec => executeQuerySpecInternal(spec, options, params, allowedDocs))
  return combineResults(results, operator)
}

export function executeQuery(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  return executeQueryInternal(query, searchOptions, params)
}
