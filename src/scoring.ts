import type { MatchInfo, SearchOptions, SearchResult } from './MiniSearch'

export type BM25Params = {
  k: number
  b: number
  d: number
}

export type LowercaseCombinationOperator = 'or' | 'and' | 'and_not'
export type CombinationOperator = LowercaseCombinationOperator | Uppercase<LowercaseCombinationOperator> | Capitalize<LowercaseCombinationOperator>

export const OR: LowercaseCombinationOperator = 'or'
export const AND: LowercaseCombinationOperator = 'and'
export const AND_NOT: LowercaseCombinationOperator = 'and_not'

export interface RawResultValue {
  score: number
  terms: string[]
  match: MatchInfo
}

export type RawResult = Map<number, RawResultValue>

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
  /** If false, doc is skipped (mutable: discarded docs). Optional on frozen. */
  isDocActive?: (docId: number) => boolean
  onInactiveDoc?: (docId: number, fieldId: number, derivedTerm: string) => void
}

export const defaultBM25params: BM25Params = { k: 1.2, b: 0.7, d: 0.5 }

export const calcBM25Score = (
  termFreq: number,
  matchingCount: number,
  totalCount: number,
  fieldLength: number,
  avgFieldLength: number,
  bm25params: BM25Params
): number => {
  const { k, b, d } = bm25params
  const invDocFreq = Math.log(1 + (totalCount - matchingCount + 0.5) / (matchingCount + 0.5))
  return invDocFreq * (d + termFreq * (k + 1) / (termFreq + k * (1 - b + b * fieldLength / avgFieldLength)))
}

export const getOwnProperty = (object: Record<string, unknown>, property: string): unknown =>
  Object.prototype.hasOwnProperty.call(object, property) ? object[property] : undefined

export const assignUniqueTerm = (target: string[], term: string): void => {
  if (!target.includes(term)) target.push(term)
}

export const assignUniqueTerms = (target: string[], source: readonly string[]): void => {
  for (const term of source) {
    if (!target.includes(term)) target.push(term)
  }
}

export type Scored = { score: number }
export const byScore = ({ score: a }: Scored, { score: b }: Scored) => b - a

/** Wrap Map<shortId, freq> as PostingListLike */
export function mapPostingList (freqs: Map<number, number>): PostingListLike {
  return {
    get size () { return freqs.size },
    forEachDoc (callback) {
      for (const [docId, termFreq] of freqs) {
        callback(docId, termFreq)
      }
    }
  }
}

/** Wrap Map<fieldId, Map<shortId, freq>> as FieldTermDataLike */
export function mapFieldTermData (data: Map<number, Map<number, number>>): FieldTermDataLike {
  return {
    get (fieldId) {
      const freqs = data.get(fieldId)
      return freqs == null ? undefined : mapPostingList(freqs)
    }
  }
}

export function aggregateTerm (
  sourceTerm: string,
  derivedTerm: string,
  termWeight: number,
  termBoost: number,
  fieldTermData: FieldTermDataLike | undefined,
  fieldBoosts: { [field: string]: number },
  context: AggregateContext,
  boostDocumentFn: ((id: unknown, term: string, storedFields?: Record<string, unknown>) => number) | undefined,
  bm25params: BM25Params,
  results: RawResult = new Map()
): RawResult {
  if (fieldTermData == null) return results

  for (const field of Object.keys(fieldBoosts)) {
    const fieldBoost = fieldBoosts[field]
    const fieldId = context.fieldIds[field]
    const postingList = fieldTermData.get(fieldId)
    if (postingList == null) continue

    let matchingFields = postingList.size
    const avgFieldLength = context.avgFieldLength[fieldId]

    postingList.forEachDoc((docId, termFreq) => {
      if (context.isDocActive != null && !context.isDocActive(docId)) {
        context.onInactiveDoc?.(docId, fieldId, derivedTerm)
        matchingFields -= 1
        return
      }

      const docBoost = boostDocumentFn
        ? boostDocumentFn(context.getExternalId(docId), derivedTerm, context.getStoredFields(docId))
        : 1
      if (!docBoost) return

      const fieldLength = context.getFieldLength(docId, fieldId)
      const rawScore = calcBM25Score(termFreq, matchingFields, context.documentCount, fieldLength, avgFieldLength, bm25params)
      const weightedScore = termWeight * termBoost * fieldBoost * docBoost * rawScore

      const result = results.get(docId)
      if (result) {
        result.score += weightedScore
        assignUniqueTerm(result.terms, sourceTerm)
        const match = getOwnProperty(result.match as Record<string, unknown>, derivedTerm) as string[] | undefined
        if (match) {
          match.push(field)
        } else {
          result.match[derivedTerm] = [field]
        }
      } else {
        results.set(docId, {
          score: weightedScore,
          terms: [sourceTerm],
          match: { [derivedTerm]: [field] }
        })
      }
    })
  }

  return results
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
    const combined = new Map<number, RawResultValue>()
    for (const docId of b.keys()) {
      const existing = a.get(docId)
      if (existing == null) continue
      const { score, terms, match } = b.get(docId)!
      assignUniqueTerms(existing.terms, terms)
      combined.set(docId, {
        score: existing.score + score,
        terms: existing.terms,
        match: Object.assign(existing.match, match)
      })
    }
    return combined
  },
  [AND_NOT]: (a, b) => {
    for (const docId of b.keys()) a.delete(docId)
    return a
  }
}

export function combineResults (results: RawResult[], combineWith: CombinationOperator = OR): RawResult {
  if (results.length === 0) return new Map()
  const operator = combineWith.toLowerCase() as LowercaseCombinationOperator
  const combinator = combinators[operator]
  if (!combinator) {
    throw new Error(`Invalid combination operator: ${combineWith}`)
  }
  return results.reduce(combinator) || new Map()
}

export interface FinalizeSearchParams {
  rawResults: RawResult
  getExternalId: (docId: number) => unknown
  getStoredFields: (docId: number) => Record<string, unknown> | undefined
  filter?: (result: SearchResult) => boolean
  skipSort?: boolean
}

export function finalizeSearchResults (params: FinalizeSearchParams): SearchResult[] {
  const { rawResults, getExternalId, getStoredFields, filter, skipSort } = params
  const results: SearchResult[] = []

  for (const [docId, { score, terms, match }] of rawResults) {
    const quality = terms.length || 1
    const result: SearchResult = {
      id: getExternalId(docId),
      score: score * quality,
      terms: Object.keys(match),
      queryTerms: terms,
      match
    }
    Object.assign(result, getStoredFields(docId))
    if (filter == null || filter(result)) {
      results.push(result)
    }
  }

  if (!skipSort) {
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
