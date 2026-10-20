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
  SearchPage,
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
  /** Undefined when the query runs without match tracking (`matchInfo: false`). */
  match: MatchInfo | undefined
}

export type RawResult = Map<number, RawResultValue>

/** Minimal docId membership view used by gated query execution. */
export interface DocIdGate extends Iterable<number> {
  readonly size: number
  has(docId: number): boolean
}

/** DocIds filled by collection: a `Set` for search gates, a `DocIdBitSet` for `matchIds`. */
export interface DocIdSet extends DocIdGate {
  add(docId: number): unknown
  delete(docId: number): unknown
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
  const boosts: { [field: string]: number } = Object.create(null)
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
  /** When false, accumulate scores and query terms only, leaving `match` undefined. */
  trackMatch?: boolean
}

/**
 * Past this many derived terms in one spec, keyed stores on fresh objects grow the root map's
 * transition tree enough (V8) to be slower than computed-key literals.
 */
const KEYED_MATCH_MAX_DERIVED_TERMS = 1024

/** Per posting list: resolved derived term, and whether and how match objects are built. */
type DerivedTermState = { value?: string, keyedMatch: boolean, trackMatch: boolean }

function getDerivedTerm(
  derivedTerm: AggregateDerivedTerm,
  cache: DerivedTermState,
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
  derivedTermCache: DerivedTermState,
  hoistedIdf?: number,
): void {
  const { trackMatch } = derivedTermCache
  // Without match tracking, only boostDocument needs the derived term string.
  const resolvedDerivedTerm = trackMatch || boostDocumentFn ? getDerivedTerm(derivedTerm, derivedTermCache) : ''
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
    if (!trackMatch) return
    const match = getOwnProperty(result.match as Record<string, unknown>, resolvedDerivedTerm) as string[] | undefined
    if (match) {
      match.push(field)
    } else {
      result.match![resolvedDerivedTerm] = [field]
    }
  } else {
    results.set(docId, {
      score: weightedScore,
      terms: [sourceTerm],
      match: !trackMatch
        ? undefined
        : derivedTermCache.keyedMatch
          ? keyedSingleMatch(resolvedDerivedTerm, field)
          : { [resolvedDerivedTerm]: [field] },
    })
  }
}

/**
 * Faster than a computed-key literal on V8 for moderate key counts; `__proto__` must still become
 * an own data property.
 */
function keyedSingleMatch(term: string, field: string): MatchInfo {
  if (term === '__proto__') return { [term]: [field] }
  const match: MatchInfo = {}
  match[term] = [field]
  return match
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
  keyedMatch: boolean,
  trackMatch: boolean,
  allowedDocs?: DocIdGate,
): void {
  const matchingFields = list.length
  const bm25 = bm25FieldConstants(bm25params, context.avgFieldLength[fieldId])
  const hoistedIdf = bm25Idf(matchingFields, context.documentCount)
  const { docIds, freqs, offset, length } = list
  const derivedTermCache: DerivedTermState = { value: undefined, keyedMatch, trackMatch }

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
  derivedTermOrdinal = 0,
): RawResult {
  if (fieldTermData == null) return results

  const keyedMatch = derivedTermOrdinal < KEYED_MATCH_MAX_DERIVED_TERMS
  const { allowedDocs, trackMatch = true } = termOptions ?? {}

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
        keyedMatch, trackMatch, allowedDocs,
      )
      continue
    }

    const matchingFields = postingList.size
    const bm25 = bm25FieldConstants(bm25params, context.avgFieldLength[fieldId])
    const hoistedIdf = bm25Idf(matchingFields, context.documentCount)
    const derivedTermCache: DerivedTermState = { value: undefined, keyedMatch, trackMatch }

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
        if (existing.match !== undefined) Object.assign(existing.match, match)
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
      if (existing.match !== undefined) Object.assign(existing.match, match)
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
  const combinator = combinatorFor(combineWith)
  if (results.length === 1) return results[0]
  return results.reduce(combinator)
}

function combinatorFor(combineWith: CombinationOperator): CombinatorFunction {
  const operator = combineWith.toLowerCase()
  // Own keys only: inherited names such as `constructor` are not operators.
  const combinator = Object.hasOwn(combinators, operator)
    ? combinators[operator as LowercaseCombinationOperator]
    : undefined
  if (!combinator) {
    throw new Error(`FrozenMiniSearch: invalid combination operator: ${combineWith}`)
  }
  return combinator
}

/** Throws for an operator that {@link combineResults} rejects, even with a single result. */
export function assertCombinationOperator(combineWith: CombinationOperator): void {
  combinatorFor(combineWith)
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
  /** False: results without `terms` and `match` (`matchInfo: false`). Defaults to true. */
  matchInfo?: boolean
}

export function resolveResultLimit(limit: unknown): number | undefined {
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
  matchInfo = true,
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
    matchInfo,
  })
}

/**
 * A result in its public shape. Without match information it has no `terms` or
 * `match` (a `ScoredResult`), and is typed as a `SearchResult` internally.
 */
export function newSearchResult(
  id: unknown,
  score: number,
  terms: string[],
  match: MatchInfo | undefined,
  matchInfo: boolean,
): SearchResult {
  return matchInfo
    ? { id, score, terms: Object.keys(match!), queryTerms: terms, match: match! }
    : { id, score, queryTerms: terms } as SearchResult
}

function materializeSearchResult(
  docId: number,
  value: RawResultValue,
  params: FinalizeSearchParams,
): SearchResult {
  const { score, terms, match } = value
  const result = newSearchResult(
    params.getExternalId(docId), score * (terms.length || 1), terms, match, params.matchInfo !== false,
  )
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

/** Rank a small prefix first, then sort the remainder only if the filter needs it. */
function* rankedCandidateBatches(scores: Float64Array, limit: number): Generator<Int32Array> {
  const order = new Int32Array(scores.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  if (limit >= scores.length / 8) {
    order.sort((a, b) => (ranksBefore(scores, a, b) ? -1 : 1))
    yield order
    return
  }
  let size = order.length
  const siftDown = (from: number): void => {
    const candidate = order[from]
    let parent = from
    for (;;) {
      const left = parent * 2 + 1
      if (left >= size) break
      const right = left + 1
      const best = right < size && ranksBefore(scores, order[right], order[left]) ? right : left
      if (!ranksBefore(scores, order[best], candidate)) break
      order[parent] = order[best]
      parent = best
    }
    order[parent] = candidate
  }
  for (let i = (size >> 1) - 1; i >= 0; i--) siftDown(i)
  const prefix = new Int32Array(Math.min(size, Math.max(64, limit * 4)))
  for (let i = 0; i < prefix.length; i++) {
    prefix[i] = order[0]
    if (--size === 0) break
    order[0] = order[size]
    siftDown(0)
  }
  yield prefix
  if (size === 0) return
  // Restore insertion order before native sort: heap order is a poor input
  // for V8's adaptive sort on postings with many tied scores.
  const pending = new Uint8Array(scores.length)
  for (let i = 0; i < size; i++) pending[order[i]] = 1
  let write = 0
  for (let i = 0; i < pending.length; i++) {
    if (pending[i]) order[write++] = i
  }
  const remaining = order.subarray(0, size)
  remaining.sort((a, b) => (ranksBefore(scores, a, b) ? -1 : 1))
  yield remaining
}

function collectResultScores(rawResults: RawResult): Float64Array {
  const scores = new Float64Array(rawResults.size)
  let entry = 0
  for (const { score, terms } of rawResults.values()) {
    scores[entry++] = score * (terms.length || 1)
  }
  return scores
}

/** Materialize selected entries in rank order, visiting the raw map once. */
function materializeRankedResults(params: FinalizeSearchParams, top: Int32Array): SearchResult[] {
  const { rawResults } = params
  const byEntry = Array.from(top.keys()).sort((a, b) => top[a] - top[b])
  const results = new Array<SearchResult>(top.length)
  let next = 0
  let entry = 0
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

/** Keep the common small top-k path independent of filtered/native-sort paths. */
function finalizeTopSearchResults(params: FinalizeSearchParams, limit: number): SearchResult[] {
  return materializeRankedResults(params, topRankIndices(collectResultScores(params.rawResults), limit))
}

/** Up to this page end, heap selection of the prefix beats selecting the page window. */
const PAGE_HEAP_MAX = 256

/** Reuse the bounded-search heap/native-sort crossover for a ranked prefix. */
function rankResultPrefix(scores: Float64Array, end: number): Int32Array {
  if (end < scores.length / 2) return topRankIndices(scores, end)
  const order = new Int32Array(scores.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  order.sort((a, b) => (ranksBefore(scores, a, b) ? -1 : 1))
  return order.subarray(0, end)
}

/**
 * Reorder `order[left..right]` so that `order[k]` holds the entry of that rank,
 * with better-ranked entries before it (quickselect, median-of-three pivot).
 */
function selectRank(scores: Float64Array, order: Int32Array, left: number, right: number, k: number): void {
  const swap = (i: number, j: number): void => {
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }
  while (right > left) {
    const mid = (left + right) >>> 1
    if (ranksBefore(scores, order[mid], order[left])) swap(mid, left)
    if (ranksBefore(scores, order[right], order[left])) swap(right, left)
    if (ranksBefore(scores, order[mid], order[right])) swap(mid, right)
    const pivot = order[right]
    let store = left
    for (let i = left; i < right; i++) {
      if (ranksBefore(scores, order[i], pivot)) swap(i, store++)
    }
    swap(store, right)
    if (store === k) return
    if (store < k) left = store + 1
    else right = store - 1
  }
}

/** Entries ranked `start..end-1`, in rank order; selects the window instead of sorting a deep prefix. */
function rankResultWindow(scores: Float64Array, start: number, end: number): Int32Array {
  if (end <= PAGE_HEAP_MAX) return rankResultPrefix(scores, end).subarray(start)
  const order = new Int32Array(scores.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  if (start > 0) selectRank(scores, order, 0, order.length - 1, start)
  if (end < order.length) selectRank(scores, order, start, order.length - 1, end)
  return order.subarray(start, end).sort((a, b) => (ranksBefore(scores, a, b) ? -1 : 1))
}

/** One scoring pass; count all filtered candidates, then select the requested page. */
export function finalizeSearchPage(params: FinalizeSearchParams, offset: number, limit?: number): SearchPage {
  const { rawResults, filter, skipSort } = params
  if (filter != null) {
    // A SearchResult predicate needs complete candidates. Keep accepted objects
    // for selection so the returned page does not materialize them a second time.
    const matches: SearchResult[] = []
    for (const [docId, value] of rawResults) {
      const result = materializeSearchResult(docId, value, params)
      if (filter(result)) matches.push(result)
    }
    const total = matches.length
    if (offset >= total || limit === 0) return { results: [], total }
    const end = Math.min(total, offset + (limit ?? total))
    const results = skipSort
      ? matches.slice(offset, end)
      : Array.from(rankResultWindow(Float64Array.from(matches, r => r.score), offset, end), i => matches[i])
    return { results, total }
  }

  const total = rawResults.size
  if (offset >= total || limit === 0) return { results: [], total }
  if (offset === 0) return { results: finalizeSearchResults({ ...params, limit }), total }
  const end = Math.min(total, offset + (limit ?? total))
  if (skipSort) {
    const results: SearchResult[] = []
    let entry = 0
    for (const [docId, value] of rawResults) {
      if (entry >= offset) results.push(materializeSearchResult(docId, value, params))
      if (++entry === end) break
    }
    return { results, total }
  }
  const order = rankResultWindow(collectResultScores(rawResults), offset, end)
  return { results: materializeRankedResults(params, order), total }
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

  if (filter == null && limit === 1) {
    let bestValue: RawResultValue | undefined
    let bestScore = -Infinity
    for (const value of rawResults.values()) {
      const score = value.score * (value.terms.length || 1)
      if (bestValue == null || score > bestScore) {
        bestValue = value
        bestScore = score
      }
    }
    for (const [docId, value] of rawResults) {
      if (value === bestValue) return [materializeSearchResult(docId, value, params)]
    }
    return []
  }

  if (filter == null && limit < rawResults.size / 2) return finalizeTopSearchResults(params, limit)

  const scores = collectResultScores(rawResults)
  // Equal-score detection is useful for filters and large limits; the common
  // small top-k path above keeps its existing selection algorithm.
  let allScoresEqual = true
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] !== scores[0]) {
      allScoresEqual = false
      break
    }
  }

  if (allScoresEqual) {
    const results: SearchResult[] = []
    for (const [docId, value] of rawResults) {
      const result = materializeSearchResult(docId, value, params)
      if (filter != null && !filter(result)) continue
      results.push(result)
      if (results.length === limit) break
    }
    return results
  }

  if (filter != null) {
    const docIds = Array.from(rawResults.keys())
    const values = Array.from(rawResults.values())
    const results: SearchResult[] = []
    for (const batch of rankedCandidateBatches(scores, limit)) {
      for (const candidate of batch) {
        const result = materializeSearchResult(docIds[candidate], values[candidate], params)
        if (filter(result)) results.push(result)
        if (results.length === limit) return results
      }
    }
    return results
  }

  // Native sorting wins over heap selection when at least half are retained.
  const docIds = Array.from(rawResults.keys())
  const values = Array.from(rawResults.values())
  const order = rankResultPrefix(scores, limit)
  const results = new Array<SearchResult>(limit)
  for (let i = 0; i < limit; i++) results[i] = materializeSearchResult(docIds[order[i]], values[order[i]], params)
  return results
}

export function finalizeSearchResults(params: FinalizeSearchParams): SearchResult[] {
  const { rawResults, getExternalId, getStoredFields, storedFieldsLayout, filter, skipSort, limit } = params
  if (limit !== undefined && limit < rawResults.size) {
    return finalizeLimitedSearchResults(params, limit)
  }
  const matchInfo = params.matchInfo !== false
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
      const result = newSearchResult(getExternalId(docId), finalScore, terms, match, matchInfo)
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
    const result = newSearchResult(getExternalId(docId), finalScore, terms, match, matchInfo)
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
