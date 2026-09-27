import {
  readDocId,
  SegmentPostingList,
  findDocIndexInSortedSegment,
  shouldSeekAllowedDocs,
} from './compactPostings'
import type {
  MatchInfo,
  Query,
  SearchOptions,
  SearchOptionsWithDefaults,
  SearchResult,
  CombinationOperator,
  LowercaseCombinationOperator,
  BM25Params,
} from './searchTypes'
import { isWildcardQuery } from './symbols'
import { assignStoredFields, type StoredFieldsLayout } from './storedFieldsLayout'
import type { PackedTermCursor } from './PackedRadixTree/types'

export type { BM25Params, CombinationOperator, LowercaseCombinationOperator } from './searchTypes'

export const OR: LowercaseCombinationOperator = 'or'
export const AND: LowercaseCombinationOperator = 'and'
export const AND_NOT: LowercaseCombinationOperator = 'and_not'

export interface RawResultValue {
  score: number
  terms: string[]
  match: MatchInfo
}

export type RawResult = Map<number, RawResultValue>

/** Minimal docId membership view used by gated query execution. */
export interface DocIdGate extends Iterable<number> {
  readonly size: number
  has(docId: number): boolean
}

/** Posting list for one (term, field): docId -> term frequency */
export interface PostingListLike {
  readonly size: number
  forEachDoc (callback: (docId: number, termFreq: number) => void): void
}

/** term -> fieldId -> posting list */
export interface FieldTermDataLike {
  get (fieldId: number): PostingListLike | undefined
}

export interface AggregateContext {
  documentCount: number
  avgFieldLength: readonly number[] | Float32Array
  fieldIds: { [key: string]: number }
  getFieldLength: (docId: number, fieldId: number) => number
  getExternalId: (docId: number) => unknown
  getStoredFields: (docId: number) => Record<string, unknown> | undefined
}

export const defaultBM25params: BM25Params = { k: 1.2, b: 0.7, d: 0.5 }

/** Per-field BM25 constants hoisted out of posting loops (avgFieldLength is fixed per field). */
type Bm25FieldConstants = {
  k: number
  d: number
  k1: number
  oneMinusB: number
  bOverAvg: number
}

function bm25FieldConstants(bm25params: BM25Params, avgFieldLength: number): Bm25FieldConstants {
  const { k, b, d } = bm25params
  return { k, d, k1: k + 1, oneMinusB: 1 - b, bOverAvg: b / avgFieldLength }
}

function bm25Idf(matchingCount: number, totalCount: number): number {
  return Math.log(1 + (totalCount - matchingCount + 0.5) / (matchingCount + 0.5))
}

function calcBm25TfWithConstants(
  termFreq: number,
  fieldLength: number,
  constants: Bm25FieldConstants,
  idf: number,
): number {
  const { k, d, k1, oneMinusB, bOverAvg } = constants
  return idf * (d + termFreq * k1 / (termFreq + k * (oneMinusB + bOverAvg * fieldLength)))
}

function calcBM25ScoreWithConstants(
  termFreq: number,
  matchingCount: number,
  totalCount: number,
  fieldLength: number,
  constants: Bm25FieldConstants,
): number {
  return calcBm25TfWithConstants(
    termFreq, fieldLength, constants, bm25Idf(matchingCount, totalCount),
  )
}

export const calcBM25Score = (
  termFreq: number,
  matchingCount: number,
  totalCount: number,
  fieldLength: number,
  avgFieldLength: number,
  bm25params: BM25Params,
): number => calcBM25ScoreWithConstants(
  termFreq, matchingCount, totalCount, fieldLength, bm25FieldConstants(bm25params, avgFieldLength),
)

const getOwnProperty = (object: Record<string, unknown>, property: string): unknown =>
  Object.hasOwn(object, property) ? object[property] : undefined

/** Field boosts for one query spec; `names` is computed once from `boosts`. */
export type FieldBoostsForQuery = {
  names: string[]
  boosts: { [field: string]: number }
}

export function fieldBoostsForQuery(
  options: SearchOptionsWithDefaults,
  fields: string[],
): FieldBoostsForQuery {
  const searchFields = options.fields || fields
  const boosts: { [field: string]: number } = {}
  for (const field of searchFields) {
    boosts[field] = (getOwnProperty(options.boost as Record<string, unknown>, field) as number) || 1
  }
  return { names: Object.keys(boosts), boosts }
}

const assignUniqueTerm = (target: string[], term: string): void => {
  if (!target.includes(term)) target.push(term)
}

const assignUniqueTerms = (target: string[], source: readonly string[]): void => {
  for (const term of source) {
    if (!target.includes(term)) target.push(term)
  }
}

export type Scored = { score: number }
export const byScore = ({ score: a }: Scored, { score: b }: Scored) => b - a

/** Eager materialized term, or a traversal cursor resolved at most once per posting list. */
export type AggregateDerivedTerm
  = | string
    | PackedTermCursor

export type AggregateTermOptions = {
  /** When set, only score postings whose docId is in this gate. Does not affect matchingFields. */
  allowedDocs?: DocIdGate
}

function getDerivedTerm(
  derivedTerm: AggregateDerivedTerm,
  cache: { value?: string },
): string {
  if (typeof derivedTerm === 'string') return derivedTerm
  if (cache.value === undefined) cache.value = derivedTerm.term()
  return cache.value
}

function scorePostingDoc(
  sourceTerm: string,
  derivedTerm: AggregateDerivedTerm,
  field: string,
  fieldId: number,
  docId: number,
  termFreq: number,
  termWeight: number,
  termBoost: number,
  fieldBoost: number,
  matchingFields: number,
  context: AggregateContext,
  boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,
  bm25: Bm25FieldConstants,
  results: RawResult,
  derivedTermCache: { value?: string },
  hoistedIdf?: number,
): void {
  const resolvedDerivedTerm = getDerivedTerm(derivedTerm, derivedTermCache)
  const docBoost = boostDocumentFn
    ? boostDocumentFn(context.getExternalId(docId), resolvedDerivedTerm, context.getStoredFields(docId))
    : 1
  if (!docBoost) return

  const fieldLength = context.getFieldLength(docId, fieldId)
  const rawScore = hoistedIdf !== undefined
    ? calcBm25TfWithConstants(termFreq, fieldLength, bm25, hoistedIdf)
    : calcBM25ScoreWithConstants(
        termFreq, matchingFields, context.documentCount, fieldLength, bm25,
      )
  const weightedScore = termWeight * termBoost * fieldBoost * docBoost * rawScore

  const result = results.get(docId)
  if (result) {
    result.score += weightedScore
    assignUniqueTerm(result.terms, sourceTerm)
    const match = getOwnProperty(result.match as Record<string, unknown>, resolvedDerivedTerm) as string[] | undefined
    if (match) {
      match.push(field)
    } else {
      result.match[resolvedDerivedTerm] = [field]
    }
  } else {
    results.set(docId, {
      score: weightedScore,
      terms: [sourceTerm],
      match: { [resolvedDerivedTerm]: [field] },
    })
  }
}

function aggregateSegmentPostingList(
  sourceTerm: string,
  derivedTerm: AggregateDerivedTerm,
  termWeight: number,
  termBoost: number,
  field: string,
  fieldId: number,
  fieldBoost: number,
  list: SegmentPostingList,
  context: AggregateContext,
  boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,
  bm25params: BM25Params,
  results: RawResult,
  allowedDocs?: DocIdGate,
): void {
  const matchingFields = list.length
  const bm25 = bm25FieldConstants(bm25params, context.avgFieldLength[fieldId])
  const hoistedIdf = bm25Idf(matchingFields, context.documentCount)
  const { docIds, freqs, offset, length } = list
  const derivedTermCache: { value?: string } = {}

  if (allowedDocs != null && shouldSeekAllowedDocs(allowedDocs.size, length)) {
    for (const docId of allowedDocs) {
      const index = findDocIndexInSortedSegment(docIds, offset, length, docId)
      if (index < 0) continue

      scorePostingDoc(
        sourceTerm, derivedTerm, field, fieldId, docId, freqs[index],
        termWeight, termBoost, fieldBoost, matchingFields,
        context, boostDocumentFn, bm25, results, derivedTermCache,
        hoistedIdf,
      )
    }
    return
  }

  for (let i = 0; i < length; i++) {
    const docId = readDocId(docIds, offset + i)
    const termFreq = freqs[offset + i]

    if (allowedDocs != null && !allowedDocs.has(docId)) continue

    scorePostingDoc(
      sourceTerm, derivedTerm, field, fieldId, docId, termFreq,
      termWeight, termBoost, fieldBoost, matchingFields,
      context, boostDocumentFn, bm25, results, derivedTermCache,
      hoistedIdf,
    )
  }
}

export function aggregateTerm(
  sourceTerm: string,
  derivedTerm: AggregateDerivedTerm,
  termWeight: number,
  termBoost: number,
  fieldTermData: FieldTermDataLike | undefined,
  fieldBoosts: FieldBoostsForQuery,
  context: AggregateContext,
  boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,
  bm25params: BM25Params,
  results: RawResult = new Map(),
  termOptions?: AggregateTermOptions,
): RawResult {
  if (fieldTermData == null) return results

  const { allowedDocs } = termOptions ?? {}

  for (const field of fieldBoosts.names) {
    const fieldBoost = fieldBoosts.boosts[field]
    const fieldId = context.fieldIds[field]
    const postingList = fieldTermData.get(fieldId)
    if (postingList == null) continue

    if (postingList instanceof SegmentPostingList) {
      aggregateSegmentPostingList(
        sourceTerm, derivedTerm, termWeight, termBoost,
        field, fieldId, fieldBoost, postingList,
        context, boostDocumentFn, bm25params, results,
        allowedDocs,
      )
      continue
    }

    const matchingFields = postingList.size
    const bm25 = bm25FieldConstants(bm25params, context.avgFieldLength[fieldId])
    const hoistedIdf = bm25Idf(matchingFields, context.documentCount)
    const derivedTermCache: { value?: string } = {}

    postingList.forEachDoc((docId, termFreq) => {
      if (allowedDocs != null && !allowedDocs.has(docId)) return

      scorePostingDoc(
        sourceTerm, derivedTerm, field, fieldId, docId, termFreq,
        termWeight, termBoost, fieldBoost, matchingFields,
        context, boostDocumentFn, bm25, results, derivedTermCache,
        hoistedIdf,
      )
    })
  }

  return results
}

function collectDocIdsFromSegmentPostingList(
  list: SegmentPostingList,
  docIds: Set<number>,
  allowedDocs?: DocIdGate,
): void {
  const { docIds: ids, offset, length } = list
  if (allowedDocs != null && shouldSeekAllowedDocs(allowedDocs.size, length)) {
    for (const docId of allowedDocs) {
      if (findDocIndexInSortedSegment(ids, offset, length, docId) >= 0) {
        docIds.add(docId)
      }
    }
    return
  }

  for (let i = 0; i < length; i++) {
    const docId = readDocId(ids, offset + i)
    if (allowedDocs != null && !allowedDocs.has(docId)) continue
    docIds.add(docId)
  }
}

/** Collect docIds from posting lists without scoring or term materialization. */
export function collectDocIdsFromFieldTermData(
  fieldTermData: FieldTermDataLike | undefined,
  fieldBoosts: FieldBoostsForQuery,
  context: AggregateContext,
  docIds: Set<number>,
  allowedDocs?: DocIdGate,
): void {
  if (fieldTermData == null) return

  for (const field of fieldBoosts.names) {
    const fieldId = context.fieldIds[field]
    const postingList = fieldTermData.get(fieldId)
    if (postingList == null) continue

    if (postingList instanceof SegmentPostingList) {
      collectDocIdsFromSegmentPostingList(postingList, docIds, allowedDocs)
      continue
    }

    postingList.forEachDoc((docId) => {
      if (allowedDocs != null && !allowedDocs.has(docId)) return
      docIds.add(docId)
    })
  }
}

type CombinatorFunction = (a: RawResult, b: RawResult) => RawResult

const combinators: Record<LowercaseCombinationOperator, CombinatorFunction> = {
  [OR]: (a, b) => {
    for (const docId of b.keys()) {
      const existing = a.get(docId)
      if (existing == null) {
        a.set(docId, b.get(docId)!)
      } else {
        const { score, terms, match } = b.get(docId)!
        existing.score = existing.score + score
        existing.match = Object.assign(existing.match, match)
        assignUniqueTerms(existing.terms, terms)
      }
    }
    return a
  },
  [AND]: (a, b) => {
    for (const docId of a.keys()) {
      const inB = b.get(docId)
      if (inB == null) {
        a.delete(docId)
        continue
      }
      const existing = a.get(docId)!
      const { score, terms, match } = inB
      existing.score += score
      assignUniqueTerms(existing.terms, terms)
      Object.assign(existing.match, match)
    }
    return a
  },
  [AND_NOT]: (a, b) => {
    for (const docId of b.keys()) a.delete(docId)
    return a
  },
}

/**
 * Combines per-term raw results. Mutates `results[0]` in place (OR/AND/AND_NOT); do not reuse
 * other entries in `results` after this call.
 */
export function combineResults(results: RawResult[], combineWith: CombinationOperator = OR): RawResult {
  if (results.length === 0) return new Map()
  const operator = combineWith.toLowerCase() as LowercaseCombinationOperator
  const combinator = combinators[operator]
  if (!combinator) {
    throw new Error(`FrozenMiniSearch: invalid combination operator: ${combineWith}`)
  }
  if (results.length === 1) return results[0]
  return results.reduce(combinator)
}

export interface FinalizeSearchParams {
  rawResults: RawResult
  getExternalId: (docId: number) => unknown
  getStoredFields?: (docId: number) => Record<string, unknown> | undefined
  /** When set, copies stored fields in place (no per-doc row allocation for single-column layouts). */
  storedFieldsLayout?: StoredFieldsLayout
  filter?: (result: SearchResult) => boolean
  skipSort?: boolean
  /** Keep only the first `limit` results of the unbounded, sorted list. */
  limit?: number
}

function resolveResultLimit(limit: unknown): number | undefined {
  if (limit === undefined || limit === Infinity) return undefined
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    throw new Error('FrozenMiniSearch: limit must be a non-negative integer or Infinity')
  }
  return limit
}

function writeStoredFieldsOntoResult(
  docId: number,
  result: SearchResult,
  storedFieldsLayout?: StoredFieldsLayout,
  getStoredFields?: (docId: number) => Record<string, unknown> | undefined,
): void {
  if (storedFieldsLayout != null) {
    assignStoredFields(storedFieldsLayout, docId, result)
    return
  }
  if (getStoredFields != null) {
    const storedFields = getStoredFields(docId)
    if (storedFields != null) Object.assign(result, storedFields)
  }
}

/** Merge search options, apply wildcard skipSort, then {@link finalizeSearchResults}. */
export function finalizeRawSearchResults(
  rawResults: RawResult,
  query: Query,
  searchOptions: SearchOptions,
  globalSearchOptions: SearchOptionsWithDefaults,
  getExternalId: (docId: number) => unknown,
  getStoredFields?: (docId: number) => Record<string, unknown> | undefined,
  storedFieldsLayout?: StoredFieldsLayout,
): SearchResult[] {
  const searchOptionsWithDefaults: SearchOptionsWithDefaults = {
    ...globalSearchOptions,
    ...searchOptions,
  }
  const skipSort = isWildcardQuery(query) && searchOptionsWithDefaults.boostDocument == null
  return finalizeSearchResults({
    rawResults,
    getExternalId,
    getStoredFields,
    storedFieldsLayout,
    filter: searchOptionsWithDefaults.filter,
    skipSort,
    limit: resolveResultLimit(searchOptionsWithDefaults.limit),
  })
}

function materializeSearchResult(
  docId: number,
  value: RawResultValue,
  params: FinalizeSearchParams,
): SearchResult {
  const { score, terms, match } = value
  const result: SearchResult = {
    id: params.getExternalId(docId),
    score: score * (terms.length || 1),
    terms: Object.keys(match),
    queryTerms: terms,
    match,
  }
  writeStoredFieldsOntoResult(docId, result, params.storedFieldsLayout, params.getStoredFields)
  return result
}

/** Rank order of the unbounded list: higher score first, then insertion order (stable sort). */
function ranksBefore(scores: Float64Array, a: number, b: number): boolean {
  return scores[a] > scores[b] || (scores[a] === scores[b] && a < b)
}

/** Indices of the `k` best entries (k < scores.length), in rank order; min-heap on the worst kept. */
function topRankIndices(scores: Float64Array, k: number): Int32Array {
  const heap = new Int32Array(k)
  let size = 0
  const siftDown = (from: number): void => {
    let i = from
    for (;;) {
      const left = 2 * i + 1
      if (left >= size) return
      const right = left + 1
      let worst = left
      if (right < size && ranksBefore(scores, heap[left], heap[right])) worst = right
      if (!ranksBefore(scores, heap[i], heap[worst])) return
      const tmp = heap[i]
      heap[i] = heap[worst]
      heap[worst] = tmp
      i = worst
    }
  }
  for (let entry = 0; entry < scores.length; entry++) {
    if (size < k) {
      let i = size++
      heap[i] = entry
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (!ranksBefore(scores, heap[parent], heap[i])) break
        const tmp = heap[i]
        heap[i] = heap[parent]
        heap[parent] = tmp
        i = parent
      }
    } else if (ranksBefore(scores, entry, heap[0])) {
      heap[0] = entry
      siftDown(0)
    }
  }
  return heap.sort((a, b) => (ranksBefore(scores, a, b) ? -1 : 1))
}

function finalizeLimitedSearchResults(params: FinalizeSearchParams, limit: number): SearchResult[] {
  const { rawResults, filter, skipSort } = params
  if (limit === 0) return []

  if (skipSort) {
    const results: SearchResult[] = []
    for (const [docId, value] of rawResults) {
      const result = materializeSearchResult(docId, value, params)
      if (filter != null && !filter(result)) continue
      results.push(result)
      if (results.length === limit) break
    }
    return results
  }

  const scores = new Float64Array(rawResults.size)
  let entry = 0
  for (const { score, terms } of rawResults.values()) {
    scores[entry++] = score * (terms.length || 1)
  }

  if (filter != null) {
    const docIds = Array.from(rawResults.keys())
    const values = Array.from(rawResults.values())
    const order = new Int32Array(scores.length)
    for (let i = 0; i < order.length; i++) order[i] = i
    order.sort((a, b) => (ranksBefore(scores, a, b) ? -1 : 1))
    const results: SearchResult[] = []
    for (let i = 0; i < order.length && results.length < limit; i++) {
      const result = materializeSearchResult(docIds[order[i]], values[order[i]], params)
      if (filter(result)) results.push(result)
    }
    return results
  }

  const top = topRankIndices(scores, limit)
  const byEntry = Array.from(top.keys()).sort((a, b) => top[a] - top[b])
  const results = new Array<SearchResult>(top.length)
  let next = 0
  entry = 0
  for (const [docId, value] of rawResults) {
    const rank = byEntry[next]
    if (top[rank] === entry) {
      results[rank] = materializeSearchResult(docId, value, params)
      if (++next === byEntry.length) break
    }
    entry++
  }
  return results
}

export function finalizeSearchResults(params: FinalizeSearchParams): SearchResult[] {
  const { rawResults, getExternalId, getStoredFields, storedFieldsLayout, filter, skipSort, limit } = params
  if (limit !== undefined && limit < rawResults.size) {
    return finalizeLimitedSearchResults(params, limit)
  }
  let allScoresEqual = true
  let firstScore: number | undefined

  if (filter == null) {
    const results = new Array<SearchResult>(rawResults.size)
    let write = 0
    for (const [docId, { score, terms, match }] of rawResults) {
      const quality = terms.length || 1
      const finalScore = score * quality
      if (firstScore == null) {
        firstScore = finalScore
      } else if (allScoresEqual && finalScore !== firstScore) {
        allScoresEqual = false
      }
      const result: SearchResult = {
        id: getExternalId(docId),
        score: finalScore,
        terms: Object.keys(match),
        queryTerms: terms,
        match,
      }
      writeStoredFieldsOntoResult(docId, result, storedFieldsLayout, getStoredFields)
      results[write++] = result
    }

    if (!skipSort && !allScoresEqual && results.length > 1) {
      results.sort(byScore)
    }
    return results
  }

  const results: SearchResult[] = []
  for (const [docId, { score, terms, match }] of rawResults) {
    const quality = terms.length || 1
    const finalScore = score * quality
    const result: SearchResult = {
      id: getExternalId(docId),
      score: finalScore,
      terms: Object.keys(match),
      queryTerms: terms,
      match,
    }
    writeStoredFieldsOntoResult(docId, result, storedFieldsLayout, getStoredFields)
    if (filter(result)) {
      if (firstScore == null) {
        firstScore = finalScore
      } else if (allScoresEqual && finalScore !== firstScore) {
        allScoresEqual = false
      }
      results.push(result)
    }
  }

  if (!skipSort && !allScoresEqual && results.length > 1) {
    results.sort(byScore)
  }
  return results
}

export type QuerySpec = {
  prefix: boolean
  fuzzy: number | boolean
  term: string
  termBoost: number
}

export const termToQuerySpec = (options: SearchOptions) => (term: string, i: number, terms: string[]): QuerySpec => {
  const fuzzy = (typeof options.fuzzy === 'function')
    ? options.fuzzy(term, i, terms)
    : (options.fuzzy || false)
  const prefix = (typeof options.prefix === 'function')
    ? options.prefix(term, i, terms)
    : (options.prefix === true)
  const termBoost = (typeof options.boostTerm === 'function')
    ? options.boostTerm(term, i, terms)
    : 1
  return { term, fuzzy, prefix, termBoost }
}
