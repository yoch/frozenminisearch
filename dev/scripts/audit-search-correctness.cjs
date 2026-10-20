#!/usr/bin/env node
'use strict'

// Reproducible public-API parity audit. Build first, then run this script.
const assert = require('node:assert/strict')
const { FrozenMiniSearch } = require('../../dist/cjs/index.require.cjs')
const MiniSearch = require('minisearch')
const initialSeed = 127391
let seed = initialSeed
const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n)
const words = ['paracetamol', 'amoxicilline', 'alpha', 'alphabet', 'gamma', '500', 'café', 'cafes', 'école', 'dose']
const sentence = () => Array.from({ length: 1 + random(5) }, () => words[random(words.length)]).join(' ')
const operators = ['AND', 'OR', 'AND_NOT']
const documentCounts = [0, 1, 31, 32, 33, 63, 64, 65, 300]
let checks = 0

for (const size of documentCounts) {
  const documents = Array.from({ length: size }, (_, id) => ({ id, title: sentence(), text: sentence(), stored: id % 3 }))
  const indexOptions = { fields: ['title', 'text'], storeFields: ['stored'] }
  const upstream = new MiniSearch(indexOptions)
  upstream.addAll(documents)
  const frozen = FrozenMiniSearch.fromDocuments(documents, indexOptions)
  const variants = [
    frozen,
    FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), indexOptions),
    FrozenMiniSearch.fromJSON(JSON.stringify(upstream), indexOptions),
  ]
  for (let iteration = 0; iteration < 150; iteration++) {
    const query = random(4) === 0
      ? { queries: [words[random(words.length)], words[random(words.length)]], combineWith: operators[random(3)] }
      : sentence()
    const options = { prefix: random(2) === 0, fuzzy: random(2) ? 0.2 : false, combineWith: operators[random(3)] }
    if (random(3) === 0) options.fields = [['title', 'text'][random(2)]]
    if (random(3) === 0) options.boostDocument = (id, term) => term.length % 2 ? 1 : id % 3
    const expectedIds = upstream.search(query, options).map(hit => hit.id).sort((a, b) => a - b)
    for (const index of variants) {
      const hits = index.search(query, options)
      assert.deepEqual(hits.map(hit => hit.id).sort((a, b) => a - b), expectedIds)
      assert.deepEqual(index.matchIds(query, options), expectedIds)
      assert.deepEqual(index.search(query, { ...options, matchInfo: false }), hits.map(({ terms, match, ...rest }) => rest))
      const filteredOptions = { ...options, filter: hit => hit.id % 3 !== 0 }
      const full = index.search(query, filteredOptions)
      assert.deepEqual(index.search(query, { ...filteredOptions, limit: 3 }), full.slice(0, 3))
      assert.deepEqual(index.searchPage(query, { ...filteredOptions, offset: 2, limit: 3 }), { total: full.length, results: full.slice(2, 5) })
      checks += 5
    }
  }
}
console.log(JSON.stringify({ checks, seed: initialSeed, documentCounts, status: 'passed' }))
