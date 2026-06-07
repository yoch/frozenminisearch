import type { Options, OptionsWithDefaults } from './searchTypes'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
  SPACE_OR_PUNCTUATION,
} from './searchDefaults'

/**
 * Indexing-time view of options: same shape as the canonical {@link OptionsWithDefaults}
 * so the mutable index, frozen builder and binary loader cannot drift.
 */
export type IndexingOptions<T> = OptionsWithDefaults<T>

export function resolveIndexingOptions<T>(options: Options<T>): IndexingOptions<T> {
  if (options?.fields == null) {
    throw new Error('MiniSearch: option "fields" must be provided')
  }
  return {
    ...defaultFrozenLoadOptions,
    ...options,
    searchOptions: { ...defaultSearchOptions, ...(options.searchOptions || {}) },
    autoSuggestOptions: { ...defaultAutoSuggestOptions, ...(options.autoSuggestOptions || {}) },
  } as IndexingOptions<T>
}

export function buildFieldIds(fields: string[]): { [key: string]: number } {
  const fieldIds: { [key: string]: number } = {}
  for (let i = 0; i < fields.length; i++) {
    fieldIds[fields[i]] = i
  }
  return fieldIds
}

function accumulateProcessedTerm(
  localFreqs: Map<string, number>,
  processedTerm: string | string[] | false | null | undefined,
): void {
  if (Array.isArray(processedTerm)) {
    for (const t of processedTerm) {
      localFreqs.set(t, (localFreqs.get(t) || 0) + 1)
    }
  } else if (processedTerm) {
    localFreqs.set(processedTerm, (localFreqs.get(processedTerm) || 0) + 1)
  }
}

/**
 * Accumulate token frequencies for one document field into `localFreqs` (cleared first).
 * Returns the number of distinct processed terms (replaces a separate `Set(tokens)` pass).
 */
export function collectFieldTermFreqsInto(
  localFreqs: Map<string, number>,
  tokens: string[],
  fieldName: string,
  processTerm: IndexingOptions<unknown>['processTerm'],
): number {
  localFreqs.clear()
  for (const term of tokens) {
    accumulateProcessedTerm(localFreqs, processTerm(term, fieldName))
  }
  return localFreqs.size
}

/** Global delimiter pattern for incremental `exec` (must not reuse {@link SPACE_OR_PUNCTUATION} — no `g` flag). */
const DEFAULT_TOKENIZE_DELIMITERS = /[\n\r\p{Z}\p{P}]+/gu

const defaultTokenizeProbe = 'a b'
const defaultTokenizeProbeField = 'f'

const tokenizeBehaviorCache = new WeakMap<
  IndexingOptions<unknown>['tokenize'],
  boolean
>()

/**
 * True when `tokenize` matches the library default (reference equality or split-equivalent
 * on a fixed probe). Custom tokenizers that pass the probe but diverge on other inputs
 * (e.g. leading delimiters) still take the fast path — use the default reference in prod.
 */
export function isDefaultTokenize(
  tokenize: IndexingOptions<unknown>['tokenize'],
): boolean {
  if (tokenize === defaultFrozenLoadOptions.tokenize) return true
  const cached = tokenizeBehaviorCache.get(tokenize)
  if (cached != null) return cached
  const splitTokens = defaultTokenizeProbe.split(SPACE_OR_PUNCTUATION)
  const customTokens = tokenize(defaultTokenizeProbe, defaultTokenizeProbeField)
  const ok = splitTokens.length === customTokens.length
    && splitTokens.every((t, i) => t === customTokens[i])
  tokenizeBehaviorCache.set(tokenize, ok)
  return ok
}

function forEachDefaultToken(text: string, onToken: (token: string) => void): void {
  if (text.length === 0) {
    onToken('')
    return
  }
  let start = 0
  const re = DEFAULT_TOKENIZE_DELIMITERS
  re.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > start) {
      onToken(text.slice(start, match.index))
    } else if (match.index === start) {
      onToken('')
    }
    start = match.index + match[0].length
  }
  if (start < text.length) {
    onToken(text.slice(start))
  } else if (start === 0) {
    onToken(text)
  } else if (start === text.length) {
    onToken('')
  }
}

/** Default tokenizer into a reusable buffer (avoids `text.split()` array allocation). */
export function tokenizeDefaultInto(out: string[], text: string): void {
  out.length = 0
  forEachDefaultToken(text, (token) => out.push(token))
}

/** Tokenize field text into `out` (reused). Fast path when `tokenize` is the library default. */
export function tokenizeFieldInto(
  out: string[],
  tokenize: IndexingOptions<unknown>['tokenize'],
  text: string,
  fieldName: string,
): void {
  if (isDefaultTokenize(tokenize)) {
    tokenizeDefaultInto(out, text)
    return
  }
  const tokens = tokenize(text, fieldName)
  out.length = 0
  out.push(...tokens)
}

function collectDefaultFieldTermFreqsInto(
  localFreqs: Map<string, number>,
  text: string,
  fieldName: string,
  processTerm: IndexingOptions<unknown>['processTerm'],
): number {
  localFreqs.clear()
  forEachDefaultToken(text, (token) => {
    accumulateProcessedTerm(localFreqs, processTerm(token, fieldName))
  })
  return localFreqs.size
}

/**
 * Tokenize + accumulate field term frequencies in one pass when the default tokenizer is used.
 * `tokenScratch` is only used for custom tokenizers (two-phase fallback).
 */
export function collectFieldTermFreqsFromFieldInto(
  localFreqs: Map<string, number>,
  tokenScratch: string[],
  tokenize: IndexingOptions<unknown>['tokenize'],
  text: string,
  fieldName: string,
  processTerm: IndexingOptions<unknown>['processTerm'],
): number {
  if (isDefaultTokenize(tokenize)) {
    return collectDefaultFieldTermFreqsInto(localFreqs, text, fieldName, processTerm)
  }
  tokenizeFieldInto(tokenScratch, tokenize, text, fieldName)
  return collectFieldTermFreqsInto(localFreqs, tokenScratch, fieldName, processTerm)
}

/** Same running average as {@link MiniSearch} private addFieldLength. */
export function updateAvgFieldLength(
  avgFieldLength: number[],
  fieldId: number,
  count: number,
  length: number,
): void {
  const averageFieldLength = avgFieldLength[fieldId] || 0
  const totalFieldLength = (averageFieldLength * count) + length
  avgFieldLength[fieldId] = totalFieldLength / (count + 1)
}

export function saveStoredFieldsForDocument<T>(
  storeFields: string[],
  extractField: IndexingOptions<T>['extractField'],
  document: T,
): Record<string, unknown> | undefined {
  if (storeFields.length === 0) return undefined
  const documentFields: Record<string, unknown> = {}
  for (const fieldName of storeFields) {
    const fieldValue = extractField(document, fieldName)
    if (fieldValue !== undefined) documentFields[fieldName] = fieldValue
  }
  return documentFields
}
