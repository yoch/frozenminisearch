# @yoch/frozenminisearch

**Read-only full-text search for Node.js** — compact frozen indexes, fast MSv5 binary loads, and the same search API as [MiniSearch](https://github.com/lucaong/minisearch) by [Luca Ongaro](https://github.com/lucaong).

> **Current release:** `1.0.0-beta.0` on npm (`beta` dist-tag)

This package is a **standalone product**: no mutable `MiniSearch` class is published. Build indexes with `fromDocuments`, the incremental builder, or migrate from an existing lucaong index via `fromMiniSearchJson`.

---

## Why frozen instead of MiniSearch?

| | lucaong `minisearch` (mutable) | `@yoch/frozenminisearch` |
|---|-------------------------------|---------------------------|
| **Use when** | Documents change (`add`, `remove`, `discard`) | Corpus is fixed or reloaded from disk |
| **Index memory** | Maps and nested objects per posting | Flat typed arrays + packed radix term tree |
| **On disk** | `toJSON` / `loadJSON` | **`saveBinarySync` / `loadBinarySync`** (MSv5) |
| **Typical search** | Baseline | Often **~20–45% faster** p50 on the same corpus |
| **Index size (heap)** | Baseline | Often **~90–99% smaller** structure |

Same BM25 scoring, prefix/fuzzy search, `autoSuggest`, wildcard, and `AND` / `OR` / `AND_NOT` queries. Functional parity with lucaong `minisearch@7` is validated in `dev/parity/` (scores `toBeCloseTo` precision 6).

---

## Quick start

```bash
npm install @yoch/frozenminisearch
```

**Build from documents:**

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }
const index = FrozenMiniSearch.fromDocuments(documents, options)

index.search('ishmael', { prefix: true })
index.autoSuggest('zen ar')

const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
```

**Incremental builder:**

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

### From lucaong `minisearch` JSON

```javascript
import MiniSearch from 'minisearch' // build-time only
import FrozenMiniSearch from '@yoch/frozenminisearch'

const mutable = new MiniSearch(options)
mutable.addAll(documents)

// Option A — live instance
const frozen = FrozenMiniSearch.fromMiniSearch(mutable, options)

// Option B — serialized index (offline / ETL)
const json = JSON.stringify(mutable)
const frozen2 = FrozenMiniSearch.fromMiniSearchJson(json, options)
```

`options.fields` must match the indexed fields in the snapshot when provided.

### From `@yoch/minisearch` 8.x

The former fork published both `MiniSearch` and `freeze()`. This package is frozen-only:

| Before (`@yoch/minisearch`) | After (`@yoch/frozenminisearch`) |
|------------------------------|----------------------------------|
| `new MiniSearch(opts).addAll(docs).freeze()` | `FrozenMiniSearch.fromDocuments(docs, opts)` or `fromMiniSearch(mutable, opts)` |
| lucaong JSON snapshot | `FrozenMiniSearch.fromMiniSearchJson(json)` or `fromMiniSearchSnapshot(obj)` |
| `import MiniSearch, { FrozenMiniSearch }` | `import FrozenMiniSearch` (+ lucaong `minisearch` only if you still build mutable indexes) |

---

## Search API (compatible with MiniSearch)

- `search(query, searchOptions?)` — string, wildcard (`FrozenMiniSearch.wildcard`), or nested `QueryCombination`
- `autoSuggest(queryString, options?)`
- `has(id)`, `getStoredFields(id)`
- `saveBinarySync` / `loadBinarySync` / async variants

Indexing is **not** available on a frozen instance — use `fromDocuments`, the builder, `fromMiniSearch*`, or `loadBinary*`.

---

## Binary snapshots (MSv5)

```javascript
const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, {}) // field names embedded in MSv5
```

- **Node ≥ 22.15.0** (zstd via `node:zlib`)
- Only **MSv5** is supported; older `MSv1`–`MSv4` snapshots must be re-saved from lucaong JSON or a mutable index
- `tokenize` / `processTerm` are not stored — pass the same functions at load when customized

---

## Benchmarks

See [benchmarks/README.md](benchmarks/README.md). Quick commands:

```bash
npm run bench              # default regression profile
npm run bench -- run --profile=vs-reference
npm run bench -- run --profile=dev --quick
npm run bench:record
npm run bench:diff
```

Representative wins (vs mutable `minisearch`, median search p50):

| Scenario | Docs | Index heap¹ | Search p50 |
|----------|------|------------|------------|
| Divina Commedia + storeFields | 14k | ~−90% | ~−35% |
| 100k documents | 100k | ~−95% | ~−43% |
| Many fields | 2k × 10 fields | ~−99% | ~−45% |

¹ Estimated structure footprint after GC — see benchmarks docs.

---

## Development

```bash
yarn install
yarn test          # src/ + dev/parity/
yarn build
node scripts/verify-npm-pack.cjs
```

Parity tests import `minisearch` as a devDependency (reference). Optional upstream clone: `git submodule update --init vendor/minisearch`.

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **@yoch/frozenminisearch** — frozen indexes, packed radix tree, MSv5 binary format

Upstream docs: [MiniSearch](https://lucaong.github.io/minisearch/)
