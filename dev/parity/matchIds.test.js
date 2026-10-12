import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'
import { mulberry32 } from '../../testSupport/mulberry32.js'

const vocabulary = [
  'alpha', 'alphabet', 'alpine', 'beta', 'better', 'bet', 'gamma', 'gamut', 'delta', 'deltoid',
  'zen', 'zebra', 'zero', 'motor', 'motorcycle', 'moto', 'café', 'cafe', 'archery', 'art',
]
const rng = mulberry32(0x5eed)
const pick = items => items[Math.floor(rng() * items.length)]
const words = count => Array.from({ length: count }, () => pick(vocabulary)).join(' ')

const docs = Array.from({ length: 400 }, (_, id) => ({
  id,
  title: words(1 + Math.floor(rng() * 3)),
  text: words(3 + Math.floor(rng() * 8)),
}))
const options = { fields: ['title', 'text'] }

function randomTerm() {
  const word = pick(vocabulary)
  const roll = rng()
  if (roll < 0.4) return word
  if (roll < 0.7) return word.slice(0, 2 + Math.floor(rng() * (word.length - 1)))
  if (roll < 0.9) {
    const at = Math.floor(rng() * word.length)
    return word.slice(0, at) + 'x' + word.slice(at + 1)
  }
  return 'missing'
}

function randomSearchOptions() {
  const searchOptions = {}
  if (rng() < 0.5) searchOptions.combineWith = pick(['OR', 'AND', 'AND_NOT'])
  if (rng() < 0.5) searchOptions.prefix = pick([true, false, (_term, i) => i % 2 === 0])
  if (rng() < 0.5) searchOptions.fuzzy = pick([0.2, 1, (term) => (term.length > 4 ? 1 : false)])
  if (rng() < 0.2) searchOptions.fields = [pick(options.fields)]
  if (rng() < 0.3) {
    searchOptions.boostDocument = pick([id => id % 3, (id, term) => (term.length % 2 ? 1 : id % 2)])
  }
  return searchOptions
}

/** A query tree with a placeholder wildcard; each library gets its own wildcard symbol. */
function randomQuery(depth) {
  if (depth > 0 && rng() < 0.3) {
    const query = { queries: Array.from({ length: 1 + Math.floor(rng() * 3) }, () => randomQuery(depth - 1)) }
    if (rng() < 0.7) query.combineWith = pick(['OR', 'AND', 'AND_NOT'])
    if (rng() < 0.3) query.prefix = true
    return query
  }
  if (rng() < 0.05) return 'WILDCARD'
  return Array.from({ length: 1 + Math.floor(rng() * 3) }, randomTerm).join(' ')
}

function withWildcard(query, wildcard) {
  if (query === 'WILDCARD') return wildcard
  if (typeof query === 'string') return query
  return { ...query, queries: query.queries.map(q => withWildcard(q, wildcard)) }
}

function upstreamIds(engine, query, searchOptions) {
  return engine.search(withWildcard(query, MiniSearch.wildcard), searchOptions)
    .map(r => r.id)
    .sort((a, b) => a - b)
}

describe('matchIds parity with MiniSearch', () => {
  test('random queries match the documents of MiniSearch search, in insertion order', () => {
    const upstream = new MiniSearch(options)
    upstream.addAll(docs)
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    let nonEmpty = 0
    for (let i = 0; i < 500; i++) {
      const query = randomQuery(2)
      const searchOptions = randomSearchOptions()
      const expected = upstreamIds(upstream, query, searchOptions)
      if (expected.length > 0) nonEmpty++
      expect(frozen.matchIds(withWildcard(query, FrozenMiniSearch.wildcard), searchOptions)).toEqual(expected)
    }
    expect(nonEmpty).toBeGreaterThan(250)
  })

  test('index-level options apply to terms but not to combination operators', () => {
    const indexOptions = { ...options, searchOptions: { combineWith: 'AND', prefix: true, fuzzy: 0.2 } }
    const upstream = new MiniSearch(indexOptions)
    upstream.addAll(docs)
    const frozen = FrozenMiniSearch.fromDocuments(docs, indexOptions)
    for (const query of ['alph zeb', { queries: ['alph', 'zeb'] }, { queries: ['alph zeb', 'gamut'] }]) {
      const expected = upstreamIds(upstream, query, {})
      expect(expected.length).toBeGreaterThan(0)
      expect(frozen.matchIds(query)).toEqual(expected)
    }
  })
})
