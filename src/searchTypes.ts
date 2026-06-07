import { WILDCARD_QUERY } from './symbols'

/**
 * BM25+ algorithm parameters.
 */
export type BM25Params = {
  k: number
  b: number
  d: number
}

export type LowercaseCombinationOperator = 'or' | 'and' | 'and_not'
export type CombinationOperator = LowercaseCombinationOperator | Uppercase<LowercaseCombinationOperator> | Capitalize<LowercaseCombinationOperator>

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Search options to customize the search behavior.
 */
export type SearchOptions = {
  /**
   * Names of the fields to search in. If omitted, all fields are searched.
   */
  fields?: string[]

  /**
   * Function used to filter search results, for example on the basis of stored
   * fields. It takes as argument each search result and should return a boolean
   * to indicate if the result should be kept or not.
   */
  filter?: (result: SearchResult) => boolean

  /**
   * Key-value object of field names to boosting values. By default, fields are
   * assigned a boosting factor of 1. If one assigns to a field a boosting value
   * of 2, a result that matches the query in that field is assigned a score
   * twice as high as a result matching the query in another field, all else
   * being equal.
   */
  boost?: { [fieldName: string]: number }

  /**
   * Function to calculate a boost factor for each query term. Returning a
   * factor lower than 1 reduces the importance of the term, greater than 1
   * increases it, and exactly 1 is neutral.
   */
  boostTerm?: (term: string, i: number, terms: string[]) => number

  /**
   * Relative weights to assign to prefix search results and fuzzy search
   * results. Exact matches are assigned a weight of 1.
   */
  weights?: { fuzzy: number, prefix: number }

  /**
   * Function to calculate a boost factor for documents. It takes as arguments
   * the document ID, and a term that matches the search in that document, and
   * the value of the stored fields for the document (if any). A falsy value
   * skips the search result completely.
   */
  boostDocument?: (documentId: any, term: string, storedFields?: Record<string, unknown>) => number

  /**
   * Controls whether to perform prefix search. Either a boolean, or a function
   * called per query term that returns a boolean.
   */
  prefix?: boolean | ((term: string, index: number, terms: string[]) => boolean)

  /**
   * Controls whether to perform fuzzy search. Either a boolean (default
   * fuzziness), a number (explicit edit distance ≥ 1, or fractional 0–1 of the
   * term length), or a function returning either.
   */
  fuzzy?: boolean | number | ((term: string, index: number, terms: string[]) => boolean | number)

  /**
   * Maximum fuzziness when using a fractional fuzzy value. Defaults to 6.
   */
  maxFuzzy?: number

  /**
   * The operand to combine partial results for each term. Defaults to "OR".
   */
  combineWith?: CombinationOperator

  /**
   * Function to tokenize the search query. By default, the same tokenizer used
   * for indexing is used also for search.
   */
  tokenize?: (text: string) => string[]

  /**
   * Function to process or normalize terms in the search query. By default, the
   * same term processor used for indexing is used also for search.
   */
  processTerm?: (term: string) => string | string[] | null | undefined | false

  /**
   * BM25+ algorithm parameters. Customizing these is almost never necessary.
   */
  bm25?: BM25Params
}

/**
 * `SearchOptions` with library defaults filled in. Used as the canonical shape
 * resolved by `MiniSearch` / `FrozenMiniSearch` before passing options around.
 */
export type SearchOptionsWithDefaults = SearchOptions & {
  boost: { [fieldName: string]: number }
  weights: { fuzzy: number, prefix: number }
  prefix: boolean | ((term: string, index: number, terms: string[]) => boolean)
  fuzzy: boolean | number | ((term: string, index: number, terms: string[]) => boolean | number)
  maxFuzzy: number
  combineWith: CombinationOperator
  bm25: BM25Params
}

/**
 * Configuration options passed to the {@link MiniSearch} constructor.
 *
 * @typeParam T  The type of documents being indexed.
 */
export type Options<T = any> = {
  /** Names of the document fields to be indexed. */
  fields: string[]
  /** Name of the ID field, uniquely identifying a document. Defaults to `"id"`. */
  idField?: string
  /** Names of fields to store, so that search results would include them. */
  storeFields?: string[]
  /** Function used to extract the value of each field in documents. */
  extractField?: (document: T, fieldName: string) => any
  /** Function used to turn field values into strings for indexing. */
  stringifyField?: (fieldValue: any, fieldName: string) => string
  /** Function used to split a field value into individual terms to be indexed. */
  tokenize?: (text: string, fieldName?: string) => string[]
  /** Function used to process a term before indexing or search (e.g. stemming). */
  processTerm?: (term: string, fieldName?: string) => string | string[] | null | undefined | false
  /** Function called to log messages from the library. */
  logger?: (level: LogLevel, message: string, code?: string) => void
  /** Auto-vacuum behaviour after {@link MiniSearch.discard}; defaults to `true`. */
  autoVacuum?: boolean | AutoVacuumOptions
  /** Default search options. */
  searchOptions?: SearchOptions
  /** Default auto-suggest options. */
  autoSuggestOptions?: SearchOptions
}

/**
 * Canonical `Options<T>` with defaults filled in. Shared by `MiniSearch`,
 * `FrozenMiniSearch`, the frozen builder, and the binary load path so they
 * cannot drift.
 */
export type OptionsWithDefaults<T = any> = Options<T> & {
  storeFields: string[]
  idField: string
  extractField: (document: T, fieldName: string) => any
  stringifyField: (fieldValue: any, fieldName: string) => string
  tokenize: (text: string, fieldName: string) => string[]
  processTerm: (term: string, fieldName: string) => string | string[] | null | undefined | false
  logger: (level: LogLevel, message: string, code?: string) => void
  autoVacuum: false | AutoVacuumOptions
  searchOptions: SearchOptionsWithDefaults
  autoSuggestOptions: SearchOptions
}

/**
 * A search-completion suggestion.
 */
export type Suggestion = {
  /** The suggested phrase. */
  suggestion: string
  /** The suggestion as an array of terms. */
  terms: string[]
  /** Score for the suggestion. */
  score: number
}

/**
 * Match information for a search result: keys are terms that matched, values
 * are the list of fields each term was found in.
 */
export type MatchInfo = {
  [term: string]: string[]
}

/**
 * A single search result, including the document ID, terms that matched, the
 * match information, the score, and all the stored fields.
 */
export type SearchResult = {
  /** The document ID. */
  id: any
  /** Document terms that matched (e.g. `"motorcycle"` for prefix `"moto"`). */
  terms: string[]
  /** Query terms that matched (e.g. `"moto"` for prefix `"moto"`). */
  queryTerms: string[]
  /** Score of the search result. */
  score: number
  /** Match information, see {@link MatchInfo}. */
  match: MatchInfo
  /** Stored fields are merged onto the result. */
  [key: string]: any
}

/** A boolean combination of sub-queries. */
export type QueryCombination = SearchOptions & { queries: Query[] }

/**
 * Wildcard query symbol, used to match all documents.
 * Use {@link FrozenMiniSearch.wildcard}.
 */
export type Wildcard = typeof WILDCARD_QUERY

/**
 * Search query expression: a query string, an expression tree combining
 * several queries with `AND`/`OR`/`AND_NOT`, or the wildcard symbol.
 */
export type Query = QueryCombination | string | Wildcard

/**
 * Options controlling vacuuming behaviour.
 */
export type VacuumOptions = {
  /** Number of terms traversed per batch. Defaults to 1000. */
  batchSize?: number
  /** Wait time between batches in milliseconds. Defaults to 10. */
  batchWait?: number
}

/**
 * Minimum thresholds for `dirtCount` and `dirtFactor` triggering an automatic
 * vacuum.
 */
export type VacuumConditions = {
  /** Minimum dirt count; defaults to 20. */
  minDirtCount?: number
  /** Minimum dirt factor; defaults to 0.1. */
  minDirtFactor?: number
}

/**
 * Options controlling auto-vacuum behaviour. Combines {@link VacuumOptions} and
 * {@link VacuumConditions}.
 */
export type AutoVacuumOptions = VacuumOptions & VacuumConditions
