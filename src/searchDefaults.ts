import { AND, OR, defaultBM25params } from './scoring'

/** Unicode space, newline, or punctuation — used by the default tokenizer */
export const SPACE_OR_PUNCTUATION = /[\n\r\p{Z}\p{P}]+/u

export const defaultSearchOptions = {
  combineWith: OR,
  prefix: false,
  fuzzy: false,
  maxFuzzy: 6,
  boost: {},
  weights: { fuzzy: 0.45, prefix: 0.375 },
  bm25: defaultBM25params,
}

export const defaultAutoSuggestOptions = {
  combineWith: AND,
  prefix: (term: string, i: number, terms: string[]): boolean =>
    i === terms.length - 1,
}

/** Option defaults applied by {@link FrozenMiniSearch.loadBinarySync} before caller overrides */
export const defaultFrozenLoadOptions = {
  idField: 'id',
  extractField: (document: any, fieldName: string) => document[fieldName],
  stringifyField: (fieldValue: any) => fieldValue.toString(),
  tokenize: (text: string) => text.split(SPACE_OR_PUNCTUATION),
  processTerm: (term: string) => term.toLowerCase(),
  storeFields: [] as string[],
  logger: (): void => {},
  autoVacuum: false as const,
}
