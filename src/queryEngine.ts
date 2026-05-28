import SearchableMap from './SearchableMap/SearchableMap'
import {
  aggregateTerm,
  combineResults,
  termToQuerySpec,
  getOwnProperty,
  type AggregateContext,
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

/**
 * Adapter exposing the index storage (mutable maps or frozen flat arrays) to the
 * shared query engine. All accessors are lazy: prefix/fuzzy results are iterated
 * only once by the engine, so wrappers should be allocated on demand.
 */
export interface QueryIndexView {
  getTermData(term: string): FieldTermDataLike | undefined
  /** Iterable of (term, data) for terms sharing the prefix. May be undefined when prefix search is not requested. */
  getPrefixMatches(term: string): Iterable<[string, FieldTermDataLike]> | undefined
  /** Map keyed by term; must support `.delete(term)` so the engine can drop fuzzy duplicates of prefix hits. */
  getFuzzyMatches(
    term: string,
    maxDistance: number,
  ): Map<string, { data: FieldTermDataLike, distance: number }> | undefined
  /** Iterate over active documents (used by wildcard queries). */
  forEachActiveDoc(callback: (docId: number, externalId: unknown, storedFields?: Record<string, unknown>) => void): void
}

export interface QueryEngineParams {
  fields: string[]
  globalSearchOptions: SearchOptionsWithDefaults
  tokenize: (text: string, fieldName?: string) => string[]
  processTerm: (term: string, fieldName?: string) => string | string[] | null | undefined | false
  indexView: QueryIndexView
  aggregateContext: AggregateContext
}

/** Shared radix-index adapter for mutable and frozen query paths. */
export function createQueryIndexView<L>(
  index: SearchableMap<L>,
  toFieldTermData: (leaf: L) => FieldTermDataLike,
  forEachActiveDoc: QueryIndexView['forEachActiveDoc'],
): QueryIndexView {
  return {
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

function fieldBoostsFromOptions(
  options: SearchOptionsWithDefaults,
  fields: string[],
): { [field: string]: number } {
  const searchFields = options.fields || fields
  const boosts: { [field: string]: number } = {}
  for (const field of searchFields) {
    boosts[field] = (getOwnProperty(options.boost as Record<string, unknown>, field) as number) || 1
  }
  return boosts
}

function executeQuerySpec(
  query: QuerySpec,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  const options: SearchOptionsWithDefaults = { ...params.globalSearchOptions, ...searchOptions }
  const boosts = fieldBoostsFromOptions(options, params.fields)
  const { boostDocument, weights, maxFuzzy, bm25 } = options
  const { fuzzy: fuzzyWeight, prefix: prefixWeight } = { ...defaultSearchOptions.weights, ...weights }
  const { indexView, aggregateContext } = params

  const score = (
    derivedTerm: string,
    termWeight: number,
    data: FieldTermDataLike | undefined,
    results?: RawResult,
  ): RawResult => aggregateTerm(
    query.term, derivedTerm, termWeight, query.termBoost,
    data, boosts, aggregateContext, boostDocument, bm25, results,
  )

  const results = score(query.term, 1, indexView.getTermData(query.term))

  const prefixMatches = query.prefix ? indexView.getPrefixMatches(query.term) : undefined

  let fuzzyMatches: Map<string, { data: FieldTermDataLike, distance: number }> | undefined
  if (query.fuzzy) {
    const fuzzy = (query.fuzzy === true) ? 0.2 : query.fuzzy
    const maxDistance = fuzzy < 1
      ? Math.min(maxFuzzy, Math.round(query.term.length * fuzzy))
      : fuzzy
    if (maxDistance) {
      fuzzyMatches = indexView.getFuzzyMatches(query.term, maxDistance)
    }
  }

  if (prefixMatches) {
    for (const [term, data] of prefixMatches) {
      const distance = term.length - query.term.length
      if (!distance) continue
      fuzzyMatches?.delete(term)
      const weight = prefixWeight * term.length / (term.length + 0.3 * distance)
      score(term, weight, data, results)
    }
  }

  if (fuzzyMatches) {
    for (const [term, { data, distance }] of fuzzyMatches) {
      if (!distance) continue
      const weight = fuzzyWeight * term.length / (term.length + distance)
      score(term, weight, data, results)
    }
  }

  return results
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

export function executeQuery(
  query: Query,
  searchOptions: SearchOptions,
  params: QueryEngineParams,
): RawResult {
  if (query === WILDCARD_QUERY) {
    return executeWildcardQuery(searchOptions, params)
  }

  if (typeof query !== 'string') {
    const combination = query as QueryCombination
    const options = { ...searchOptions, ...combination, queries: undefined }
    const results = combination.queries.map(subquery =>
      executeQuery(subquery, options, params),
    )
    return combineResults(results, options.combineWith as CombinationOperator)
  }

  const options = {
    tokenize: params.tokenize,
    processTerm: params.processTerm,
    ...params.globalSearchOptions,
    ...searchOptions,
  }
  const { tokenize, processTerm } = options
  const terms = tokenize(query)
    .flatMap((term: string) => processTerm(term))
    .filter(term => !!term) as string[]
  const specs: QuerySpec[] = terms.map(termToQuerySpec(options))
  const results = specs.map(spec => executeQuerySpec(spec, options, params))
  return combineResults(results, options.combineWith as CombinationOperator)
}
