import { defaultFrozenLoadOptions, SPACE_OR_PUNCTUATION } from './searchDefaults'
import {
  collectFieldTermFreqsFromFieldInto,
  collectFieldTermFreqsInto,
  isDefaultTokenize,
  tokenizeDefaultInto,
} from './indexingCore'

const PARITY_CASES = [
  '',
  'hello',
  'hello world',
  'a  b',
  '::a',
  'a::',
  'a ',
  '  ',
  'foo-bar baz',
  'CIS 10 mg',
  'comprimé pelliculé',
  'lorem—ipsum',
  'one\ntwo',
  'tab\there',
]

function freqMapFromSplit(text, fieldName, processTerm) {
  const freqs = new Map()
  for (const token of text.split(SPACE_OR_PUNCTUATION)) {
    const processed = processTerm(token, fieldName)
    if (Array.isArray(processed)) {
      for (const t of processed) {
        freqs.set(t, (freqs.get(t) || 0) + 1)
      }
    } else if (processed) {
      freqs.set(processed, (freqs.get(processed) || 0) + 1)
    }
  }
  return freqs
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

describe('indexingCore default tokenizer', () => {
  test('tokenizeDefaultInto matches split(SPACE_OR_PUNCTUATION)', () => {
    const out = []
    for (const text of PARITY_CASES) {
      tokenizeDefaultInto(out, text)
      expect(out).toEqual(text.split(SPACE_OR_PUNCTUATION))
    }
  })

  test('collectFieldTermFreqsFromFieldInto matches split + collectFieldTermFreqsInto', () => {
    const fieldName = 'txt'
    const processTerm = term => term.toLowerCase()
    const tokenScratch = []
    const localFreqs = new Map()

    for (const text of PARITY_CASES) {
      const expected = freqMapFromSplit(text, fieldName, processTerm)
      const unique = collectFieldTermFreqsFromFieldInto(
        localFreqs,
        tokenScratch,
        defaultFrozenLoadOptions.tokenize,
        text,
        fieldName,
        processTerm,
      )
      expect(mapToObject(localFreqs)).toEqual(mapToObject(expected))
      expect(unique).toBe(expected.size)

      const tokens = text.split(SPACE_OR_PUNCTUATION)
      const fromTwoPhase = collectFieldTermFreqsInto(
        localFreqs,
        tokens,
        fieldName,
        processTerm,
      )
      expect(fromTwoPhase).toBe(unique)
      expect(mapToObject(localFreqs)).toEqual(mapToObject(expected))
    }
  })

  test('isDefaultTokenize accepts split-equivalent custom function', () => {
    const equivalent = text => text.split(SPACE_OR_PUNCTUATION)
    expect(isDefaultTokenize(equivalent)).toBe(true)
    expect(isDefaultTokenize(text => text.split(','))).toBe(false)
  })
})
