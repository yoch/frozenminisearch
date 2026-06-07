# @yoch/frozenminisearch

**Read-only full-text search for Node.js** — compact frozen indexes, fast binary snapshots, and a **drop-in** search API for frozen workloads: same `search`, `autoSuggest`, scoring, and query options as [MiniSearch](https://github.com/lucaong/minisearch) by [Luca Ongaro](https://github.com/lucaong).

> **Current release:** `1.0.1` on npm

**Design goal:** once an index is built or loaded, migrate with the minimum code change — package name and index construction only; serving code stays the same. No mutable `MiniSearch` class is published here; build indexes with `fromDocuments`, the incremental builder, or migrate from an existing lucaong index via `fromMiniSearchJson`.

---

## Why frozen instead of MiniSearch?

**Mutable** lucaong `minisearch` when documents change (`add`, `remove`, `discard`). **Frozen** when the corpus is fixed or shipped as a binary snapshot — same BM25, prefix/fuzzy, `autoSuggest`, wildcard, and `AND` / `OR` / `AND_NOT`. Parity with `minisearch@7` is validated in `dev/parity/` (scores `toBeCloseTo` precision 6).

<!-- vs-reference:start — npm run bench:readme -->
### Measured vs lucaong MiniSearch (reference baseline)

Same BM25 queries on identical corpora. **Frozen wins on what we optimize for**: RAM, disk, cold load, and search throughput on real workloads.

| Scenario | Docs | Index RAM¹ | Disk (binary vs JSON)² | Cold load³ | Search p50⁴ |
|----------|-----:|------------|------------------------:|-----------:|------------:|
| Divina with storeFields | 14,097 | 1.1 vs 16.0 MB (~93% less) | ~73% less | ~70% faster | ~13% faster |
| Divina index only | 14,097 | 0.3 vs 14.9 MB (~98% less) | ~77% less | ~86% faster | ~8% faster |
| high-frequency terms (10k docs) | 10,000 | 0.2 vs 7.4 MB (~98% less) | ~94% less | ~93% faster | ~29% faster |
| Dense numeric ids (100k, identity lookup) | 100,000 | 1.6 vs 91.2 MB (~98% less) | ~88% less | ~91% faster | ~18% faster |
| Doc id Uint16 boundary (65535 docs) | 65,535 | 1.1 vs 58.6 MB (~98% less) | ~91% less | ~93% faster | ~43% faster |

**Headline:** 22/27 query benchmarks favor frozen (paired **hrtime** protocol v2). Divina `inferno` (exact, paired p50): mutable 16.2 µs → frozen 13.7 µs (**-2 µs**, ratio 0.90).

Decomposition (Divina exact): L0 lookup ~300 ns frozen, L1 `executeQuery` ~8.3 µs, L2 full `search` ~11.6 µs (finalize ≈ 3 µs).

| | lucaong `minisearch` | `@yoch/frozenminisearch` |
|---|------------------------|---------------------------|
| **Sweet spot** | Live index mutations | Fixed corpus, deploy from binary |
| **Production path** | `addAll` → `toJSON` | `fromDocuments` / `fromMiniSearch` → `saveBinarySync` → `loadBinarySync` |
| **Typical trade-off** | Higher RAM, JSON snapshots | One-time freeze, then compact binary |

<details>
<summary><strong>How to read these numbers (limits &amp; protocol)</strong></summary>

- **Captured:** 2026-06-07 · commit `9f32207` · Node v24.16.0 · minisearch **7.2.0** · **3** run(s)/scenario · protocol **v2** (hrtime-paired, batch target 3 ms).
- ¹ **Index RAM** — `measureHeap` with `--expose-gc`, one index alive. V8 overhead is extra; treat as **trend**, not accounting. Sporadic outliers happen (e.g. index-only Divina).
- ² **Disk** — `JSON.stringify(mutable)` vs `saveBinarySync`.
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

## Drop-in

For **fixed corpora** (build once, serve read-only), treat this package as a drop-in replacement for lucaong `minisearch` on the serving path.

**Change only:**

| What | Before | After |
|------|--------|-------|
| Package | lucaong `minisearch` | `@yoch/frozenminisearch` |
| Construction | `new MiniSearch(opts).addAll(docs)` | `FrozenMiniSearch.fromDocuments(docs, opts)` or `fromMiniSearch(mutable, opts)` |
| JSON snapshot | `MiniSearch.loadJSON(json)` / `toJSON()` wire format | `FrozenMiniSearch.fromMiniSearchJson(json, opts)` or `fromMiniSearchSnapshot(obj)` — no runtime dependency on lucaong `minisearch` |

**Keep unchanged** after load: `search`, `autoSuggest`, `has`, `getStoredFields`, query options (`prefix`, `fuzzy`, `AND` / `OR` / `AND_NOT`, filters, boosts). Parity vs `minisearch@7` is enforced in `dev/parity/`.

**Imports** — default and named both work (ESM and CJS):

```javascript
// ESM
import FrozenMiniSearch from '@yoch/frozenminisearch'
import { FrozenMiniSearch } from '@yoch/frozenminisearch'

// CommonJS
const FrozenMiniSearch = require('@yoch/frozenminisearch')
const { FrozenMiniSearch } = require('@yoch/frozenminisearch')
```

**Intentionally not drop-in:** live `add` / `remove` / `discard` (frozen is read-only); browser builds; custom `tokenize` / `processTerm` are not stored in JSON or binary snapshots — pass the same functions at load when you customized them.

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

### From lucaong `minisearch` (mutable → frozen)

| Before (mutable) | After (`@yoch/frozenminisearch`) |
|------------------|----------------------------------|
| `new MiniSearch(opts).addAll(docs)` then serve | `FrozenMiniSearch.fromDocuments(docs, opts)` or `fromMiniSearch(mutable, opts)` |
| lucaong JSON snapshot | `FrozenMiniSearch.fromMiniSearchJson(json)` or `fromMiniSearchSnapshot(obj)` |
| `import MiniSearch from 'minisearch'` | `import FrozenMiniSearch from '@yoch/frozenminisearch'` (+ lucaong `minisearch` only if you still build mutable indexes) |

---

## Search API (compatible with MiniSearch)

- `search(query, searchOptions?)` — string, wildcard (`FrozenMiniSearch.wildcard`), or nested `QueryCombination`
- `autoSuggest(queryString, options?)`
- `has(id)`, `getStoredFields(id)`
- `saveBinarySync` / `loadBinarySync` / async variants

Indexing is **not** available on a frozen instance — use `fromDocuments`, the builder, `fromMiniSearch*`, or `loadBinary*`.

---

## Binary snapshots

```javascript
const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, {}) // field names embedded in snapshot
```

- **Node ≥ 22.15.0** (zstd via `node:zlib`)
- Snapshots produced by this package version are forward-compatible; re-build from lucaong JSON if an older binary fails to load
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

Design notes (freq adaptive, AND gating): [dev/docs/README.md](dev/docs/README.md).

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **@yoch/frozenminisearch** — frozen indexes, packed radix tree, compact binary snapshots

Upstream docs: [MiniSearch](https://lucaong.github.io/minisearch/)
