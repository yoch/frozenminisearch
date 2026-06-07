# @yoch/frozenminisearch

**Read-only full-text search for Node.js** — compact frozen indexes, fast MSv5 binary loads, and the same search API as [MiniSearch](https://github.com/lucaong/minisearch) by [Luca Ongaro](https://github.com/lucaong).

> **Current release:** `1.0.0-beta.0` on npm (`beta` dist-tag)

This package is a **standalone product**: no mutable `MiniSearch` class is published. Build indexes with `fromDocuments`, the incremental builder, or migrate from an existing lucaong index via `fromMiniSearchJson`.

---

## Why frozen instead of MiniSearch?

**Mutable** lucaong `minisearch` when documents change (`add`, `remove`, `discard`). **Frozen** when the corpus is fixed or shipped as a binary snapshot — same BM25, prefix/fuzzy, `autoSuggest`, wildcard, and `AND` / `OR` / `AND_NOT`. Parity with `minisearch@7` is validated in `dev/parity/` (scores `toBeCloseTo` precision 6).

<!-- vs-reference:start — npm run bench:readme -->
### Measured vs lucaong MiniSearch (reference baseline)

Same BM25 queries on identical corpora. **Frozen wins on what we optimize for**: RAM, disk, cold load, and search throughput on real workloads.

| Scenario | Docs | Index RAM¹ | Disk (binary vs JSON)² | Cold load³ | Search p50⁴ |
|----------|-----:|------------|------------------------:|-----------:|------------:|
| Divina with storeFields | 14,097 | 1.1 vs 16.0 MB (~93% less) | ~73% less | ~71% faster | ~14% faster |
| Divina index only | 14,097 | 0.3 vs 14.9 MB (~98% less) | ~77% less | ~86% faster | ~3% faster |
| high-frequency terms (10k docs) | 10,000 | 0.2 vs 7.4 MB (~97% less) | ~94% less | ~90% faster | ~32% faster |
| Dense numeric ids (100k, identity lookup) | 100,000 | 1.7 vs 91.2 MB (~98% less) | ~88% less | ~90% faster | ~21% faster |
| Doc id Uint16 boundary (65535 docs) | 65,535 | 1.1 vs 58.6 MB (~98% less) | ~91% less | ~94% faster | ~38% faster |

**Headline:** 22/27 query benchmarks favor frozen (paired **hrtime** protocol v2). Divina `inferno` (exact, paired p50): mutable 16.3 µs → frozen 13.8 µs (**-2 µs**, ratio 0.87).

Decomposition (Divina exact): L0 lookup ~300 ns frozen, L1 `executeQuery` ~8.1 µs, L2 full `search` ~11.5 µs (finalize ≈ 3 µs).

| | lucaong `minisearch` | `@yoch/frozenminisearch` |
|---|------------------------|---------------------------|
| **Sweet spot** | Live index mutations | Fixed corpus, deploy from binary |
| **Production path** | `addAll` → `toJSON` | `fromDocuments` / `fromMiniSearch` → `saveBinarySync` → `loadBinarySync` |
| **Typical trade-off** | Higher RAM, JSON snapshots | One-time freeze, then compact MSv5 |

<details>
<summary><strong>How to read these numbers (limits &amp; protocol)</strong></summary>

- **Captured:** 2026-06-07 · commit `2a9a90d` · Node v24.16.0 · minisearch **7.2.0** · **3** run(s)/scenario · protocol **v2** (hrtime-paired, batch target 3 ms).
- ¹ **Index RAM** — `measureHeap` with `--expose-gc`, one index alive. V8 overhead is extra; treat as **trend**, not accounting. Sporadic outliers happen (e.g. index-only Divina).
- ² **Disk** — `JSON.stringify(mutable)` vs MSv5 `saveBinarySync`.
- ³ **Cold load** — median wall time to searchable index after read from disk format.
- ⁴ **Search p50** — paired mutable/frozen samples per iteration; sub-0.1 ms baselines reported in **µs** in full reports. Fast queries use **50** iterations, others **20**.
- **Not shown:** mutable `add`/`remove` (frozen is read-only by design). Freeze time is offline — see full suite for build metrics.
- **Reproduce:** `npm run bench -- run --profile=vs-reference` · **Update this block:** `npm run bench:readme` after refreshing `benchmarks/baselines/reference.json`.

</details>
<!-- vs-reference:end -->

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

See [benchmarks/README.md](benchmarks/README.md).

```bash
npm run bench -- run --profile=vs-reference   # compare frozen vs minisearch
npm run bench:diff                          # regression vs reference.json
npm run bench:readme                          # refresh comparison table above
```

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
