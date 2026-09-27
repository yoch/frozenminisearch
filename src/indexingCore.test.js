import { defaultFrozenLoadOptions, SPACE_OR_PUNCTUATION } from './searchDefaults'
import FrozenMiniSearch from './FrozenMiniSearch'
import {
  collectFieldTermFreqsFromFieldInto,
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

  test('tokenizeDefaultInto matches split for every code point in every position', () => {
    const out = []
    const mismatches = []
    const check = (text) => {
      tokenizeDefaultInto(out, text)
      const expected = text.split(SPACE_OR_PUNCTUATION)
      if (out.length !== expected.length || out.some((t, i) => t !== expected[i])) {
        mismatches.push(text)
      }
    }
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const ch = String.fromCodePoint(cp)
      check(`a${ch}b`)
      if (cp < 0x10000) check(`${ch}${ch}`)
    }
    for (const lone of ['\ud800', '\udbff', '\udc00', '\udfff']) {
      for (const neighbor of ['a', ' ', ',', '\u3001', '\ud83d\ude00', '\ud800', '\udc00', '']) {
        check(`${lone}${neighbor}`)
        check(`${neighbor}${lone}`)
        check(`x${neighbor}${lone}${neighbor}y`)
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([])
  })

  test('tokenizeDefaultInto matches split on random mixed-script text', () => {
    const alphabet = ['a', 'Z', '7', ' ', '\u00a0', ',', '.', '-', '_', '\n', '\r', '\t', 'é', '—', '…',
      '日', '本', '\u3000', '\u3001', 'ж', '«', '»', '\u2028', '\ud83d\ude00', '\ud800', '\udc00', '𝔸']
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed / 0x100000000
    }
    const out = []
    for (let round = 0; round < 5000; round++) {
      let text = ''
      const len = Math.floor(rand() * 24)
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)]
      tokenizeDefaultInto(out, text)
      expect(out).toEqual(text.split(SPACE_OR_PUNCTUATION))
    }
  })

  test('collectFieldTermFreqsFromFieldInto matches split for default and custom-equivalent tokenizers', () => {
    const fieldName = 'txt'
    const processTerm = term => term.toLowerCase()
    const equivalentTokenize = text => text.split(SPACE_OR_PUNCTUATION)
    const tokenScratch = []
    const rawTokenScratch = new Set()
    const localFreqs = new Map()

    for (const text of PARITY_CASES) {
      const expected = freqMapFromSplit(text, fieldName, processTerm)
      const tokens = text.split(SPACE_OR_PUNCTUATION)
      const unique = collectFieldTermFreqsFromFieldInto(
        localFreqs,
        rawTokenScratch,
        tokenScratch,
        defaultFrozenLoadOptions.tokenize,
        text,
        fieldName,
        processTerm,
      )
      expect(mapToObject(localFreqs)).toEqual(mapToObject(expected))
      expect(unique.fieldLength).toBe(new Set(tokens).size)
      expect(unique.indexedTermCount).toBe(expected.size)

      const fromTwoPhase = collectFieldTermFreqsFromFieldInto(
        localFreqs,
        rawTokenScratch,
        tokenScratch,
        equivalentTokenize,
        text,
        fieldName,
        processTerm,
      )
      expect(fromTwoPhase.fieldLength).toBe(unique.fieldLength)
      expect(fromTwoPhase.indexedTermCount).toBe(unique.indexedTermCount)
      expect(mapToObject(localFreqs)).toEqual(mapToObject(expected))
    }
  })

  test('isDefaultTokenize accepts only the default tokenizer reference', () => {
    expect(isDefaultTokenize(FrozenMiniSearch.getDefault('tokenize'))).toBe(true)
    const equivalent = text => text.split(SPACE_OR_PUNCTUATION)
    expect(isDefaultTokenize(equivalent)).toBe(false)
    expect(isDefaultTokenize(text => text.split(','))).toBe(false)
  })

  test('custom camelCase tokenizer indexes split terms via fromFieldInto', () => {
    const camelCaseLike = (text) => {
      const tokens = []
      for (const word of text.split(/[\s\-._/:@]+/)) {
        if (!word) continue
        const lower = word.toLowerCase()
        tokens.push(lower)
        const split = word
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .split(/\s+/)
          .map(w => w.toLowerCase())
          .filter(w => w.length > 0)
        if (split.length > 1) tokens.push(...split)
      }
      return tokens.filter(w => w.length > 0)
    }
    expect(isDefaultTokenize(camelCaseLike)).toBe(false)

    const localFreqs = new Map()
    const rawTokenScratch = new Set()
    const tokenScratch = []
    const processTerm = term => term.toLowerCase()
    const collected = collectFieldTermFreqsFromFieldInto(
      localFreqs,
      rawTokenScratch,
      tokenScratch,
      camelCaseLike,
      'createUser',
      'title',
      processTerm,
    )
    expect(collected.indexedTermCount).toBe(3)
    expect(mapToObject(localFreqs)).toEqual({
      create: 1,
      createuser: 1,
      user: 1,
    })
  })

  test('custom tokenizer returning more tokens than the call stack allows', () => {
    const text = Array.from({ length: 200_000 }, (_, i) => `w${i % 997}`).join(' ')
    const index = FrozenMiniSearch.fromDocuments([{ id: 1, body: text }], {
      fields: ['body'],
      tokenize: s => s.split(' '),
    })
    expect(index.search('w0').map(r => r.id)).toEqual([1])
  })
})
