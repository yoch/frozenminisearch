import { mulberry32 } from '../testSupport/mulberry32.js'

function randInt (rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1))
}

function pickChar (rand, alphabet) {
  return alphabet[Math.floor(rand() * alphabet.length)]
}

function allTerms (alphabet, maxDepth) {
  const terms = ['']
  function visit (prefix, depth) {
    if (depth === maxDepth) return
    for (const char of alphabet) {
      const term = prefix + char
      terms.push(term)
      visit(term, depth + 1)
    }
  }
  visit('', 0)
  return terms
}

function asciiRandomTerms (count, seed) {
  const rand = mulberry32(seed)
  const terms = new Set()
  while (terms.size < count) {
    const len = randInt(rand, 3, 12)
    let s = ''
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(97 + Math.floor(rand() * 26))
    }
    terms.add(s)
  }
  return [...terms]
}

/** Five shared prefixes (5–15 chars) + suffixes (2–30 chars), 5000 unique keys. */
function prefixSuffixKeys (count, seed) {
  const rand = mulberry32(seed)
  const prefixes = []
  for (let i = 0; i < 5; i++) {
    const len = randInt(rand, 5, 15)
    let p = ''
    for (let j = 0; j < len; j++) {
      p += String.fromCharCode(97 + Math.floor(rand() * 26))
    }
    prefixes.push(p)
  }

  const terms = new Set()
  let guard = 0
  while (terms.size < count && guard < count * 20) {
    guard++
    const prefix = prefixes[Math.floor(rand() * prefixes.length)]
    const suffixLen = randInt(rand, 2, 30)
    let suffix = ''
    for (let j = 0; j < suffixLen; j++) {
      suffix += String.fromCharCode(97 + Math.floor(rand() * 26))
    }
    terms.add(prefix + suffix)
  }
  if (terms.size < count) {
    throw new Error(`prefixSuffixKeys: could only generate ${terms.size}/${count} unique terms`)
  }
  return { terms: [...terms], prefixes }
}

/** Numeric strings only (digits), variable length, 10k unique keys. */
function numericKeys (count, seed) {
  const rand = mulberry32(seed)
  const terms = new Set()
  let guard = 0
  while (terms.size < count && guard < count * 20) {
    guard++
    const len = randInt(rand, 4, 14)
    let s = ''
    for (let j = 0; j < len; j++) {
      s += String.fromCharCode(48 + Math.floor(rand() * 10))
    }
    if (s.length > 0) terms.add(s)
  }
  if (terms.size < count) {
    throw new Error(`numericKeys: could only generate ${terms.size}/${count} unique terms`)
  }
  return [...terms]
}

/** Build a reproducible alphabet of `size` single-code-unit characters. */
function buildAlphabet (size) {
  const chars = []
  for (let cp = 0x100; chars.length < size && cp <= 0xffff; cp++) {
    const ch = String.fromCodePoint(cp)
    if (ch.length === 1) chars.push(ch)
  }
  if (chars.length < size) {
    throw new Error(`buildAlphabet: only ${chars.length} chars available (wanted ${size})`)
  }
  return chars
}

const ALPHABET_800 = buildAlphabet(800)

/** Fixed length keys over a wide alphabet (800 distinct chars). */
function shortKeysWideAlphabet (count, keyLength, seed) {
  const rand = mulberry32(seed)
  const terms = new Set()
  let guard = 0
  while (terms.size < count && guard < count * 20) {
    guard++
    let s = ''
    for (let i = 0; i < keyLength; i++) {
      s += pickChar(rand, ALPHABET_800)
    }
    terms.add(s)
  }
  if (terms.size < count) {
    throw new Error(`shortKeysWideAlphabet: could only generate ${terms.size}/${count} unique terms`)
  }
  return [...terms]
}

function fuzzyProbe (hit) {
  if (hit.length <= 1) return hit + 'z'
  const last = hit.charCodeAt(hit.length - 1)
  const repl = last === 122 || last === 57 ? 'a' : String.fromCharCode(last + 1)
  return hit.slice(0, -1) + repl
}

function probesFromHit (hit) {
  return {
    getHit: hit,
    getMiss: 'zzzzzzzzzzzz',
    midEdgeMiss: hit.slice(0, Math.max(1, Math.floor(hit.length / 2))),
    prefixShort: hit.slice(0, 1),
    prefixLong: hit.slice(0, Math.min(3, hit.length)),
    fuzzyQuery: fuzzyProbe(hit),
  }
}

function corpusFromTerms (id, terms, benchCpu, extra = {}) {
  const hit = terms[0]
  return {
    id,
    benchCpu,
    entries: terms.map((term, i) => [term, i]),
    probes: probesFromHit(hit),
    ...extra,
  }
}

const smallTerms = ['summer', 'acqua', 'aqua', 'acquire', 'poisson', 'qua']
const denseTerms = allTerms(['a', 'b', 'c'], 3).filter((t) => t.length > 0)
const scaleTerms = asciiRandomTerms(2000, 0xdecafbad)

const prefixSuffix5k = prefixSuffixKeys(5000, 0x50fa5eed)
const numeric10k = numericKeys(10000, 0x6e756d3130)
const short5Wide10k = shortKeysWideAlphabet(10000, 5, 0x7769646531)

/** @type {Array<{ id: string, entries: Array<[string, number]>, probes: object, benchCpu?: boolean, meta?: object }>} */
export const corpora = [
  corpusFromTerms('small', smallTerms, false),
  corpusFromTerms('dense-prefix', denseTerms, false),
  corpusFromTerms('scale', scaleTerms, true),
  corpusFromTerms('prefix-suffix-5k', prefixSuffix5k.terms, false, {
    meta: {
      kind: 'prefix-suffix',
      keyCount: 5000,
      prefixCount: 5,
      prefixLengths: '5-15',
      suffixLengths: '2-30',
      samplePrefixes: prefixSuffix5k.prefixes,
    },
  }),
  corpusFromTerms('numeric-10k', numeric10k, false, {
    meta: {
      kind: 'numeric',
      keyCount: 10000,
      alphabet: '0-9',
      keyLengths: '4-14',
    },
  }),
  corpusFromTerms('short5-alphabet800-10k', short5Wide10k, false, {
    meta: {
      kind: 'short-fixed-wide-alphabet',
      keyCount: 10000,
      keyLength: 5,
      alphabetSize: ALPHABET_800.length,
      alphabetStartCodePoint: 0x100,
    },
  }),
]
