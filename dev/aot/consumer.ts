import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import {
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} from '@yoch/frozenminisearch'

type Doc = { id: number; txt: string }

const options = { fields: ['txt'], storeFields: ['txt'] }
const docs: Doc[] = JSON.parse(readFileSync(process.argv[2], 'utf8'))

function pickQueries(): string[] {
  const words = new Set<string>()
  for (let i = 0; i < docs.length; i += 97) {
    for (const word of docs[i].txt.toLowerCase().split(/[^\p{L}]+/u)) {
      if (word.length > 2) words.add(word)
    }
  }
  return [...words].slice(0, 120)
}

const queries = pickQueries()

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function runQueries(index: Pick<FrozenMiniSearch<Doc>, 'search' | 'searchPage' | 'autoSuggest'>): string {
  const out: unknown[] = []
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]
    const pair = `${query} ${queries[(i * 7 + 3) % queries.length]}`
    out.push(index.search(query))
    out.push(index.search(query.slice(0, 3), { prefix: true }))
    out.push(index.search(query, { fuzzy: 0.2 }))
    out.push(index.search(query, { fuzzy: 0.3, prefix: true, weights: { fuzzy: 0.4, prefix: 0.6 } }))
    out.push(index.search(pair, { combineWith: 'AND' }))
    out.push(index.search(pair, { combineWith: 'AND_NOT' }))
    out.push(index.search(pair, { limit: 5 }))
    out.push(index.searchPage(pair, { offset: 3, limit: 7 }))
    out.push(index.autoSuggest(query.slice(0, 4), { fuzzy: 0.2 }))
  }
  return digest(out)
}

const built = FrozenMiniSearch.fromDocuments(docs, options)
const report: Record<string, string> = {
  search: runQueries(built),
  storedFields: digest([1, 500, docs.length - 1].map((id) => built.getStoredFields(id))),
}

const builder = createFrozenIndexBuilder<Doc>(options)
builder.addAll(docs)
report.builder = runQueries(freezeFrozenIndexBuilder(builder))
report.fromJSON = runQueries(FrozenMiniSearch.fromJSON(JSON.stringify(built), options))

const compressions = typeof zlib.zstdCompressSync === 'function'
  ? (['raw', 'zlib', 'auto', 'zstd'] as const)
  : (['raw', 'zlib', 'auto'] as const)
for (const compression of compressions) {
  const bytes = built.saveBinarySync({ compression })
  const asyncBytes = await built.saveBinaryAsync({ compression })
  report[`binary.${compression}.sync`] = runQueries(FrozenMiniSearch.loadBinarySync<Doc>(bytes, options))
  report[`binary.${compression}.async`] = runQueries(await FrozenMiniSearch.loadBinaryAsync<Doc>(asyncBytes, options))
}

console.log(JSON.stringify(report))
