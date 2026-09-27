import type { Options, OptionsWithDefaults } from './searchTypes'
import { getFrozenDefault } from './searchDefaults'
import { resolveFrozenOptions } from './frozenOptions'

/**
 * Indexing-time view of options: same shape as the canonical {@link OptionsWithDefaults}
 * so the mutable index, frozen builder and binary loader cannot drift.
 */
export type IndexingOptions<T> = OptionsWithDefaults<T>

export function resolveIndexingOptions<T>(options: Options<T>): IndexingOptions<T> {
  return resolveFrozenOptions(options)
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

/** Single-code-point form of the default `split` pattern; the source of truth for delimiter classes. */
const DEFAULT_DELIMITER_CODE_POINT = /^[\n\r\p{Z}\p{P}]$/u

const LATIN1_DELIMITER = new Uint8Array(256)
for (let c = 0; c < 256; c++) {
  LATIN1_DELIMITER[c] = DEFAULT_DELIMITER_CODE_POINT.test(String.fromCharCode(c)) ? 1 : 0
}

const BMP_UNKNOWN = 0
const BMP_DELIMITER = 1
const BMP_TOKEN = 2
/** Per-code-unit memo for U+0100..U+FFFF in 256-unit blocks, allocated only for blocks seen in text. */
const bmpDelimiterMemo: (Uint8Array | undefined)[] = new Array(256)

function isBmpDelimiter(c: number): boolean {
  const block = bmpDelimiterMemo[c >>> 8] ??= new Uint8Array(256)
  const low = c & 0xff
  let state = block[low]
  if (state === BMP_UNKNOWN) {
    state = DEFAULT_DELIMITER_CODE_POINT.test(String.fromCharCode(c)) ? BMP_DELIMITER : BMP_TOKEN
    block[low] = state
  }
  return state === BMP_DELIMITER
}

/** Code units of the delimiter code point at `i`, or 0 when it belongs to a token. */
function delimiterWidthAt(text: string, i: number): number {
  const c = text.charCodeAt(i)
  if (c < 256) return LATIN1_DELIMITER[c]
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = text.charCodeAt(i + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      return DEFAULT_DELIMITER_CODE_POINT.test(text.slice(i, i + 2)) ? 2 : 0
    }
    return 0
  }
  return isBmpDelimiter(c) ? 1 : 0
}

function isSurrogatePairAt(text: string, i: number): boolean {
  const c = text.charCodeAt(i)
  if (c < 0xd800 || c > 0xdbff) return false
  const next = text.charCodeAt(i + 1)
  return next >= 0xdc00 && next <= 0xdfff
}

/**
 * True only for the library default tokenizer reference. Custom tokenizers — including
 * split-equivalent wrappers — always take the two-phase indexing path.
 */
export function isDefaultTokenize(
  tokenize: IndexingOptions<unknown>['tokenize'],
): boolean {
  return tokenize === getFrozenDefault('tokenize')
}

/** Same tokens as `text.split(/[\n\r\p{Z}\p{P}]+/u)`, including empty leading/trailing tokens. */
function forEachDefaultToken(text: string, onToken: (token: string) => void): void {
  const n = text.length
  let start = 0
  let i = 0
  while (i < n) {
    let width = delimiterWidthAt(text, i)
    if (width === 0) {
      i += isSurrogatePairAt(text, i) ? 2 : 1
      continue
    }
    const runStart = i
    do {
      i += width
    } while (i < n && (width = delimiterWidthAt(text, i)) !== 0)
    onToken(text.slice(start, runStart))
    start = i
  }
  onToken(text.slice(start))
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
  for (const token of tokens) out.push(token)
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
