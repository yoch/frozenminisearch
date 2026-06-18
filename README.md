# FrozenMiniSearch

[![npm version](https://img.shields.io/npm/v/@yoch/frozenminisearch.svg)](https://www.npmjs.com/package/@yoch/frozenminisearch)
[![coverage](https://codecov.io/gh/yoch/frozenminisearch/graph/badge.svg)](https://codecov.io/gh/yoch/frozenminisearch)
[![CI](https://github.com/yoch/frozenminisearch/actions/workflows/main.yml/badge.svg)](https://github.com/yoch/frozenminisearch/actions/workflows/main.yml)

[API documentation](https://yoch.github.io/frozenminisearch/)

**Memory-optimized, read-only full-text search for Node.js.** FrozenMiniSearch keeps the serving API close to [MiniSearch](https://github.com/lucaong/minisearch) while using compact, immutable indexes for fixed corpora.

Use it when your documents are built offline, shipped to production, and queried many times. In that shape, frozen indexes use **~98-99% less index RAM** in the main benchmark set, save to compact binary snapshots, and load faster than MiniSearch JSON.

If you need live `add`, `remove`, or `discard`, use MiniSearch. If the corpus is fixed, this package is designed to keep the search experience familiar while making each serving replica much smaller.

---

## Why FrozenMiniSearch?

FrozenMiniSearch is for the common production path where search data changes elsewhere, not inside the web process:

- Build or import the index offline.
- Save it as a compact binary snapshot.
- Load it in many read-only Node.js processes.
- Query with MiniSearch-style `search`, `autoSuggest`, filters, boosts, prefix/fuzzy search, wildcard, and `AND` / `OR` / `AND_NOT`.

Internally it replaces mutable JavaScript object graphs with packed radix postings, typed arrays, and columnar stored fields. The result is less flexible than MiniSearch, but much cheaper to keep resident.

<!-- vs-reference:start — npm run bench:readme -->
### Measured vs MiniSearch

Same corpora, same BM25-style queries, MiniSearch 7.2.0 as the reference.

| Scenario | Docs | Index RAM | Binary size | Load time | Search p50 |
|----------|-----:|-----------|------------:|----------:|-----------:|
| Divina, with stored text | 14,097 | 0.3 vs 16.1 MB (~98% less) | ~73% less | ~75% faster | ~14% faster |
| Divina, index only | 14,097 | 0.2 vs 14.9 MB (~99% less) | ~77% less | ~89% faster | ~23% faster |
| High-frequency terms | 10,000 | 4.4 vs 7.4 MB (~41% less) | ~94% less | ~91% faster | ~40% faster |
| Dense numeric ids | 100,000 | 0.9 vs 91.3 MB (~99% less) | ~88% less | ~94% faster | ~27% faster |
| Uint16 doc id boundary | 65,535 | 0.6 vs 58.6 MB (~99% less) | ~91% less | ~93% faster | ~43% faster |

Across this full run, frozen is faster on **25/27** search cases. Divina `inferno` (exact, paired p50): mutable 15.0 µs → frozen 13.4 µs (**-2 µs**, ratio 0.78).

Numbers are from `benchmarks/baselines/reference.json`, captured 2026-06-18 on Node v24.16.0, 3 runs per scenario. Heap is measured with one index alive and should be read as a trend, not exact accounting.
<!-- vs-reference:end -->

---

## Quick start

```bash
npm install @yoch/frozenminisearch
```

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }
const index = FrozenMiniSearch.fromDocuments(documents, options)

index.search('ishmael', { prefix: true })
index.autoSuggest('zen ar')

const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
```

For larger imports, use the incremental builder:

```javascript
import FrozenMiniSearch, {
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} from '@yoch/frozenminisearch'

const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: rows.length })
for (const doc of rows) builder.add(doc)
const index = freezeFrozenIndexBuilder(builder)
```

ESM and CommonJS are both supported (`main` → CJS, `module` → ESM).

---

## Migration

For fixed corpora, most serving code can stay the same. Change how the index is built or loaded, then keep calling `search`, `autoSuggest`, `has`, and `getStoredFields`.

Default and named imports both work:

```javascript
// ESM
import FrozenMiniSearch from '@yoch/frozenminisearch'
import { FrozenMiniSearch } from '@yoch/frozenminisearch'

// CommonJS
const FrozenMiniSearch = require('@yoch/frozenminisearch')
const { FrozenMiniSearch } = require('@yoch/frozenminisearch')
```

Build directly:

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch'

const frozen = FrozenMiniSearch.fromDocuments(documents, options)
```

Or freeze an existing MiniSearch index:

```javascript
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '@yoch/frozenminisearch'

const mutable = new MiniSearch(options)
mutable.addAll(documents)

const frozen = FrozenMiniSearch.fromMiniSearch(mutable, options)
const fromJson = FrozenMiniSearch.fromJson(JSON.stringify(mutable), options)
```

MiniSearch is only needed if you still build mutable indexes. Frozen instances do not support live `add`, `remove`, or `discard`.

---

## Search API (compatible with MiniSearch)

- `search(query, searchOptions?)` — string, wildcard (`FrozenMiniSearch.wildcard`), or nested `QueryCombination`
- `autoSuggest(queryString, options?)`
- `has(id)`, `getStoredFields(id)`
- `saveBinarySync` / `loadBinarySync` / async variants

Custom `tokenize` and `processTerm` functions are not stored in snapshots; pass the same functions again when loading.

---

## Binary snapshots

Binary snapshots are the preferred production format.

```javascript
const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, {}) // field names embedded in snapshot
```

- **Node ≥ 20**
- `compression: 'auto'` chooses `zstd` on Node 22.15+, otherwise `zlib`, and falls back to raw when compression does not help.
- Use explicit compression when you need a portable artifact:

```javascript
const portable = index.saveBinarySync({ compression: 'zlib' })
const uncompressed = index.saveBinarySync({ compression: 'raw' })
const bestRatio = index.saveBinarySync({ compression: 'zstd' }) // Node 22.15+
```

Raw and zlib snapshots load on Node 20+. zstd snapshots require Node 22.15+.

---

## Benchmarks

See [benchmarks/README.md](benchmarks/README.md).

```bash
npm run bench -- run --profile=vs-reference   # compare frozen vs minisearch
npm run bench:diff                            # regression vs reference.json
npm run bench:readme -- --from=benchmarks/baselines/latest.json
```

---

## Development

```bash
yarn install
yarn test          # src/ + dev/parity/
yarn build
node scripts/verify-npm-pack.cjs
```

Parity tests compare against MiniSearch 7. Longer notes and performance work live under [dev/docs/README.md](dev/docs/README.md) and [benchmarks/README.md](benchmarks/README.md).

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **@yoch/frozenminisearch** — memory-optimized frozen indexes and compact binary snapshots

Upstream docs: [MiniSearch](https://lucaong.github.io/minisearch/)
