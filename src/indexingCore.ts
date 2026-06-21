import type { Options, OptionsWithDefaults } from './searchTypes'
import {
  defaultSearchOptions,
  defaultAutoSuggestOptions,
  defaultFrozenLoadOptions,
  getFrozenDefault,
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

/** Global delimiter pattern for incremental `exec` (must not reuse {@link SPACE_OR_PUNCTUATION} — no `g` flag). */
const DEFAULT_TOKENIZE_DELIMITERS = /[\n\r\p{Z}\p{P}]+/gu

/**
 * True only for the library default tokenizer reference. Custom tokenizers — including
 * split-equivalent wrappers — always take the two-phase indexing path.
 */
export function isDefaultTokenize(
  tokenize: IndexingOptions<unknown>['tokenize'],
): boolean {
  return tokenize === getFrozenDefault('tokenize')
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
  forEachDefaultToken(text, token => out.push(token))
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

export type FieldTermCollectResult = {
  /** Unique raw token count (MiniSearch field length semantics). */
  fieldLength: number
  /** Distinct indexed terms after `processTerm`. */
  indexedTermCount: number
}

function collectDefaultFieldTermFreqsInto(
  localFreqs: Map<string, number>,
  rawTokenScratch: Set<string>,
  text: string,
  fieldName: string,
  processTerm: IndexingOptions<unknown>['processTerm'],
): FieldTermCollectResult {
  localFreqs.clear()
  rawTokenScratch.clear()
  forEachDefaultToken(text, (token) => {
    rawTokenScratch.add(token)
    accumulateProcessedTerm(localFreqs, processTerm(token, fieldName))
  })
  return {
    fieldLength: rawTokenScratch.size,
    indexedTermCount: localFreqs.size,
  }
}

function collectTokenArrayFieldTermFreqsInto(
  localFreqs: Map<string, number>,
  rawTokenScratch: Set<string>,
  tokens: string[],
  fieldName: string,
  processTerm: IndexingOptions<unknown>['processTerm'],
): FieldTermCollectResult {
  localFreqs.clear()
  rawTokenScratch.clear()
  for (const token of tokens) {
    rawTokenScratch.add(token)
    accumulateProcessedTerm(localFreqs, processTerm(token, fieldName))
  }
  return {
    fieldLength: rawTokenScratch.size,
    indexedTermCount: localFreqs.size,
  }
}

/**
 * Tokenize + accumulate field term frequencies. Field length uses unique raw
 * tokens (matching MiniSearch); postings use terms that survive `processTerm`.
 */
export function collectFieldTermFreqsFromFieldInto(
  localFreqs: Map<string, number>,
  rawTokenScratch: Set<string>,
  tokenScratch: string[],
  tokenize: IndexingOptions<unknown>['tokenize'],
  text: string,
  fieldName: string,
  processTerm: IndexingOptions<unknown>['processTerm'],
): FieldTermCollectResult {
  if (isDefaultTokenize(tokenize)) {
    return collectDefaultFieldTermFreqsInto(
      localFreqs, rawTokenScratch, text, fieldName, processTerm,
    )
  }
  tokenizeFieldInto(tokenScratch, tokenize, text, fieldName)
  return collectTokenArrayFieldTermFreqsInto(
    localFreqs, rawTokenScratch, tokenScratch, fieldName, processTerm,
  )
}

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
