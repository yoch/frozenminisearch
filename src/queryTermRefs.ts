import { SegmentPostingList } from './compactPostings'
import type {
  AggregateContext,
  AggregateDerivedTerm,
  FieldBoostsForQuery,
  FieldTermDataLike,
  QuerySpec,
} from './scoring'
import type { CombinationOperator, SearchOptionsWithDefaults } from './searchTypes'
import type { QueryEngineParams } from './queryEngine'

export type NormalizedStringQuery = {
  options: SearchOptionsWithDefaults & Pick<QueryEngineParams, 'tokenize' | 'processTerm'>
  operator: CombinationOperator
  specs: QuerySpec[]
  fieldBoosts: FieldBoostsForQuery
  fuzzyWeight: number
  prefixWeight: number
}

type QuerySpecTermRef
  = 'exact' | 'prefix' | 'fuzzy'

function maxFuzzyDistance(query: QuerySpec, maxFuzzy: number): number {
  if (!query.fuzzy) return 0
  const fuzzy = (query.fuzzy === true) ? 0.2 : query.fuzzy
  return fuzzy < 1
    ? Math.min(maxFuzzy, Math.round(query.term.length * fuzzy))
    : fuzzy
}

export function forEachQuerySpecTermRef(
  query: QuerySpec,
  normalized: NormalizedStringQuery,
  params: QueryEngineParams,
  visit: (
    kind: QuerySpecTermRef,
    termIndex: number | undefined,
    length: number,
    distance: number,
  ) => void,
): void {
  const { indexView } = params
  const { options } = normalized
  const maxDistance = maxFuzzyDistance(query, options.maxFuzzy)

  visit('exact', indexView.resolveTermIndex(query.term), query.term.length, 0)

  const seenPrefix = query.prefix && maxDistance ? new Set<number>() : undefined
  if (query.prefix) {
    indexView.visitPrefixMatchesByIndex(query.term, (termIndex, length) => {
      const distance = length - query.term.length
      if (!distance) return
      seenPrefix?.add(termIndex)
      visit('prefix', termIndex, length, distance)
    })
  }
  if (!maxDistance) return
  indexView.visitFuzzyMatchesByIndex(query.term, maxDistance, (termIndex, length, distance) => {
    if (!distance || seenPrefix?.has(termIndex)) return
    visit('fuzzy', termIndex, length, distance)
  })
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
  const { fuzzyWeight, prefixWeight } = normalized

  forEachQuerySpecTermRef(query, normalized, params, (kind, termIndex, length, distance) => {
    const { indexView } = params
    if (kind === 'exact') {
      visit(
        termIndex == null ? undefined : indexView.fieldTermData(termIndex),
        query.term,
        1,
      )
      return
    }
    if (termIndex == null) return
    const derivedTerm: AggregateDerivedTerm = termIndex
    if (kind === 'prefix') {
      visit(
        indexView.fieldTermData(termIndex),
        derivedTerm,
        prefixWeight * length / (length + 0.3 * distance),
      )
      return
    }
    visit(
      indexView.fieldTermData(termIndex),
      derivedTerm,
      fuzzyWeight * length / (length + distance),
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

  forEachQuerySpecTermRef(query, normalized, params, (kind, termIndex) => {
    if (kind === 'exact') {
      if (termIndex != null) consider(indexView.fieldTermData(termIndex))
      return
    }
    if (termIndex != null) consider(indexView.fieldTermData(termIndex))
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
