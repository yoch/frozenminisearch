import { SegmentPostingList } from './compactPostings'
import type {
  AggregateContext,
  AggregateDerivedTerm,
  FieldBoostsForQuery,
  FieldTermDataLike,
  QuerySpec,
} from './scoring'
import type { CombinationOperator, SearchOptionsWithDefaults } from './searchTypes'
import type { QueryEngineParams, QueryIndexView } from './queryEngine'

export type NormalizedStringQuery = {
  options: SearchOptionsWithDefaults & Pick<QueryEngineParams, 'tokenize' | 'processTerm'>
  operator: CombinationOperator
  specs: QuerySpec[]
  fieldBoosts: FieldBoostsForQuery
  fuzzyWeight: number
  prefixWeight: number
}

type QuerySpecTermRef
  = | { kind: 'exact', termIndex: number | undefined }
    | { kind: 'prefix', termIndex: number, length: number, distance: number }
    | { kind: 'fuzzy', termIndex: number, length: number, distance: number }

function maxFuzzyDistance(query: QuerySpec, maxFuzzy: number): number {
  if (!query.fuzzy) return 0
  const fuzzy = (query.fuzzy === true) ? 0.2 : query.fuzzy
  return fuzzy < 1
    ? Math.min(maxFuzzy, Math.round(query.term.length * fuzzy))
    : fuzzy
}

function lazyIndexedTerm(
  indexView: QueryIndexView,
  termIndex: number,
): AggregateDerivedTerm {
  return { kind: 'lazy', resolve: () => indexView.resolveTermByIndex(termIndex) }
}

export function forEachQuerySpecTermRef(
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

export function visitQuerySpecForScoring(
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

export function estimateMaxPostingLengthForQuerySpec(
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

function hasCheapTwoPhasePostingEstimate(query: QuerySpec): boolean {
  return !query.prefix && !query.fuzzy
}

export function estimateCheapTwoPhasePostingLengthForQuerySpec(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
): number | undefined {
  return hasCheapTwoPhasePostingEstimate(query)
    ? estimateMaxPostingLengthForQuerySpec(query, normalized, params)
    : undefined
}
