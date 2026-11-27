'use strict'
// Untyped CommonJS consumer, shaped like fr.gouv.medicaments.rest: `require` of the
// package, async-iterable and builder indexing, function-valued prefix/fuzzy, custom
// tokenize/processTerm, AND, matchIds, filter, limit and matchInfo: false, and the
// default `require` shape documented in the README.
// `bun build --compile --aot` must resolve the "aot" condition for `require` too.
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const library = require('@yoch/frozenminisearch')
const {
  AND,
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} = library

// README form: `require` returns the class itself, with the named exports attached
// (dist/cjs/index.require.cjs, and dist/aot/index.require.cjs under --aot).
if (typeof library !== 'function' || library !== FrozenMiniSearch || library.default !== FrozenMiniSearch ||
    library.AND !== AND || library.createFrozenIndexBuilder !== createFrozenIndexBuilder) {
  console.error(`require('@yoch/frozenminisearch') is not the FrozenMiniSearch class (typeof ${typeof library})`)
  process.exit(1)
}

const docs = JSON.parse(readFileSync(process.argv[2], 'utf8'))

function normalize (text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function tokenize (text) {
  return text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0)
}

const searchOptions = {
  tokenize,
  processTerm: normalize,
  combineWith: AND,
  prefix: (term) => !/^\d+$/.test(term),
  fuzzy: (term) => (/^\d/.test(term) ? false : 0.2),
}
const options = {
  fields: ['txt'],
  storeFields: [],
  tokenize,
  processTerm: normalize,
  searchOptions,
}

function pickQueries () {
  const words = new Set()
  for (let i = 0; i < docs.length; i += 89) {
    for (const word of tokenize(docs[i].txt)) {
      if (word.length > 3) words.add(word)
    }
  }
  return [...words].slice(0, 100)
}

const queries = pickQueries()

function digest (value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function runQueries (index) {
  const out = []
  const even = (result) => result.id % 2 === 0
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]
    const pair = `${query} ${queries[(i * 5 + 1) % queries.length].slice(0, 4)}`
    out.push(index.search(query, { matchInfo: false }))
    out.push(index.search(pair, { matchInfo: false, limit: 20 }))
    out.push(index.search(pair, { matchInfo: false, filter: even, limit: 10 }))
    out.push(index.search(pair))
    out.push(index.matchIds(pair))
  }
  return digest(out)
}

async function * stream () {
  for (const doc of docs) yield { id: doc.id, txt: doc.txt }
}

async function main () {
  const report = {}
  report.asyncIterable = runQueries(await FrozenMiniSearch.fromAsyncIterable(stream(), options))

  const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: docs.length })
  for (let i = 0; i < docs.length; i++) builder.add(docs[i])
  const frozen = freezeFrozenIndexBuilder(builder)
  report.builder = runQueries(frozen)
  report.binary = runQueries(FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options))
  report.defaultRequire = runQueries(library.fromDocuments(docs, options))

  console.log(JSON.stringify(report))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
