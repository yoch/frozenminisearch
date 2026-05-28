# @yoch/minisearch

**In-memory full-text search for Node.js** — a fork of [MiniSearch](https://github.com/lucaong/minisearch) by [Luca Ongaro](https://github.com/lucaong/minisearch), extended for **production serving**: smaller indexes, faster loads, and a read-only fast path.

> **Current release:** `8.1.0` · install with `npm install @yoch/minisearch`

---

## Why this fork?

[MiniSearch](https://github.com/lucaong/minisearch) is excellent for building and querying an index in JavaScript. This fork keeps that API for **mutable** indexing, and adds **`FrozenMiniSearch`** for when the index is built once and queried many times:

| | Mutable `MiniSearch` | `FrozenMiniSearch` |
|---|---------------------|-------------------|
| **Use when** | Documents change (`add`, `remove`, `discard`) | Corpus is fixed, or you reload from disk |
| **Memory** | Maps and nested objects per posting | Flat `Uint32Array` / `Uint8Array` postings |
| **On disk** | `toJSON` / `loadJSON` | **`saveBinary` / `loadBinary`** (MSv4 / MSv3) |
| **Typical search** | Baseline | Often **~20–35% faster** p50 on the same corpus (see benchmarks) |

Same BM25 scoring, prefix/fuzzy search, `autoSuggest`, and query combinators — frozen indexes aim for **search ranking parity** with `addAll` + `freeze()` when built with the same options. Term frequencies are stored as `Uint8` (max **255** per document/field); extreme repetition can cause a small score drift versus the mutable index.

---

## Quick start

```bash
npm install @yoch/minisearch
# pre-releases: npm install @yoch/minisearch@beta
```

**One-shot frozen index** (no mutable step):

```javascript
import { FrozenMiniSearch } from '@yoch/minisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }

const index = FrozenMiniSearch.fromDocuments(documents, options)
index.search('ishmael', { prefix: true })
index.autoSuggest('zen')

// Persist and reload
const buf = index.saveBinary()
const loaded = FrozenMiniSearch.loadBinary(buf, options)
```

**Mutable index, then freeze** (incremental build):

```javascript
import MiniSearch, { FrozenMiniSearch } from '@yoch/minisearch'

const ms = new MiniSearch({ fields: ['title', 'text'] })
ms.addAll(documents)

const frozen = ms.freeze()   // immutable snapshot
const buf = frozen.saveBinary()
```

```javascript
// ESM
import MiniSearch, { FrozenMiniSearch, buildFrozenFromDocuments } from '@yoch/minisearch'

// CommonJS
const MiniSearch = require('@yoch/minisearch')
const { FrozenMiniSearch } = require('@yoch/minisearch')
```

---

## Pick the right API

| Goal | API |
|------|-----|
| Live index that changes over time | `MiniSearch` → `freeze()` when you need read-only serving |
| Fixed corpus, build frozen directly | **`FrozenMiniSearch.fromDocuments(documents, options)`** |
| Build doc-by-doc (no `documents[]` buffer) | **`createFrozenIndexBuilder(options)`** → `.add(doc)` → **`freezeFrozenIndexBuilder(builder)`** |
| Async stream of documents | **`FrozenMiniSearch.fromAsyncIterable(iterable, options)`** |
| Load a snapshot from disk | `FrozenMiniSearch.loadBinary(buffer, options)` |
| Custom assembly pipeline | `buildFrozenFromDocuments`, `assembleFrozen`, `freezeFromMiniSearch` |

`fromDocuments` matches `new MiniSearch(opts).addAll(docs).freeze()` for search ranking on the same corpus and options (`fields`, `tokenize`, `processTerm`, …). Frozen indexes do not support `add` / `remove`.

**External corpus (e.g. lookup by id after search):** keep full rows in your own store (`dataCache`, DB, etc.) and use minimal `storeFields` (often `['id']` only) so the frozen index does not duplicate payload text:

```javascript
import { createFrozenIndexBuilder, freezeFrozenIndexBuilder } from '@yoch/minisearch'

function buildFrozenIndexFromRows (rows, options) {
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount: rows.length
  })
  for (let i = 0; i < rows.length; i++) {
    builder.add(buildIndexDocument(rows[i], i))
  }
  return freezeFrozenIndexBuilder(builder)
}

// After search: enrich from your store — frozen.getStoredFields(res.id) or dataCache[type][res.id]
```

**Async stream** (no intermediate array; documents are indexed as they arrive):

```javascript
import { createReadStream } from 'node:fs'
import { parse } from 'csv-parse'
import { FrozenMiniSearch } from '@yoch/minisearch'

async function buildFromCsv (path, options) {
  async function * documents () {
    const parser = createReadStream(path).pipe(parse({ columns: true }))
    for await (const row of parser) {
      yield { id: row.cis, denomination: row.denomination, /* … */ }
    }
  }
  return FrozenMiniSearch.fromAsyncIterable(documents(), options)
}
```

For a **sync** iterable (`for...of` on an array or generator), use the builder directly:

```javascript
import { createFrozenIndexBuilder, freezeFrozenIndexBuilder } from '@yoch/minisearch'

const builder = createFrozenIndexBuilder(options)
for (const doc of documentGenerator()) {
  builder.add(doc)
}
const frozen = freezeFrozenIndexBuilder(builder)
```

`estimatedDocumentCount` in the second argument to `createFrozenIndexBuilder` pre-allocates
per-document arrays when the final size is known; internal buffers are trimmed to the actual
count on freeze if the hint was too large.

---

## FrozenMiniSearch in a bit more detail

- **`freeze()`** — snapshot a mutable index into compact typed postings + a radix tree keyed by term index.
- **`fromDocuments()`** — build that structure in one pass (skips nested `Map` postings and radix cloning at freeze time).
- **`createFrozenIndexBuilder()`** — same output without a temporary `documents[]` array; finalize with `freezeFrozenIndexBuilder(builder)` (or `assembleFrozen(builder.freezeParams())` for custom assembly).
- **`fromAsyncIterable()`** — async document stream (e.g. CSV parser) into a frozen index; equivalent to builder + `for await` + `freezeFrozenIndexBuilder`.
- **`saveBinary()` / `loadBinary()`** — **MSv4** (sparse multi-field, Uint16 doc ids when possible) or **MSv3** (single-field dense, Uint32 doc ids). **MSv1/MSv2 are not supported** — re-save older snapshots. Field names are stored in the snapshot; `fields` in `loadBinary` options is **optional** (if provided, it must match exactly). Custom `tokenize` / `processTerm` are **not** stored — pass the same functions at load time if you customized them. `storeFields` data is embedded in the snapshot.
- **Term frequencies** — stored as `Uint8` (max 255 per doc/term); only affects scores for extreme term repetition.
- **`frozenMemoryBreakdown()`** — introspect postings, radix tree, and stored-field footprint (estimates only; not exact heap accounting).

**Mutable index → frozen:** prefer a fixed corpus. If you used `discard()` on a `MiniSearch` index, run `vacuum()` before `freeze()` to shrink the snapshot; search parity is still expected without vacuum, but the binary may retain sparse slots.

**Advanced API** (`assembleFrozen`, `freezeFromMiniSearch`, `FrozenIndexBuilder`) is for custom pipelines — most apps should use `fromDocuments`, `freeze()`, or the builder helpers above.

Advanced exports:

```javascript
import {
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
  FrozenIndexBuilder,
  type FrozenIndexBuilderHints,
  buildFrozenFromDocuments,
  assembleFrozen,
  freezeFromMiniSearch,
  frozenMemoryBreakdown
} from '@yoch/minisearch'
```

---

## MiniSearch (mutable)

Full upstream-style API: field boosts, fuzzy/prefix, nested queries, `AND` / `OR` / `AND_NOT`, filters, `autoSuggest`, vacuum after `discard`, etc.

```javascript
import MiniSearch from '@yoch/minisearch'

const miniSearch = new MiniSearch({ fields: ['title', 'text'] })
miniSearch.addAll(documents)
miniSearch.search('zen art motorcycle')
```

TypeScript definitions: `dist/es/index.d.ts`.

---

## FrozenMiniSearch — optimizations

### Already in MSv3 / MSv4 (8.0.0+)

| Area | Change | Effect |
|------|--------|--------|
| **Format** | MSv3 replaces MSv1/MSv2 (breaking) | CRC32 payload check; binary field names, ids, stored fields, term tree |
| **Format** | MSv4 added: sparse postings for multi-field indexes, `Uint16` doc ids when `nextId ≤ 65535`, dynamic sparse field-id width | Smaller on-disk + in-memory footprint; MSv3 still written for single-field/`Uint32` |
| **Build/Format** | Term dictionary rebuilt in `saveBinary()` instead of kept in memory | No resident `_terms[]` duplicate of the radix tree |
| **Build** | Adaptive external-id lookup (`identity` vs lazy `Map`) | Contiguous numeric ids cost no lookup table |
| **Build/Search** | `freeze()` compacts discarded slots to a dense id range | No holes to skip; wildcard iterates only active docs |
| **Binary load** | Structural validation in `decodeFrozenSnapshot` / `validateFrozenSnapshot` | Corrupt snapshots fail fast with `Invalid frozen index: …` |
| **`loadBinary`** | `fields` optional (embedded in snapshot); if provided, must match exactly | Simpler reload; no silent field subset |
| **`saveBinary`** | Single pre-allocated buffer | Lower peak memory while serializing |
| **Search** | Per-query cache for `fieldTermDataFor(termIndex)` | Fewer allocations on prefix/fuzzy queries |

Measure regressions with [`benchmarks/`](benchmarks/README.md) (`freezeMs`, `saveBinary`, `loadBinary`, search p50, heap frozen).

### Suggested follow-ups (not implemented yet)

| Priority | Topic | Idea | Trade-off |
|----------|-------|------|-----------|
| **Format** | On-disk dictionary | Reconstruct terms from the radix tree on load, drop the dictionary section | Smaller snapshots; slower load |
| **API** | `loadBinaryAsync` | Chunked/async load like `loadJSONAsync` | Better cold start on huge indexes |
| **API** | Input types | Accept `Uint8Array` as well as `Buffer` on `loadBinary` | Broader runtime support |
| **Build** | `freeze` / builder | One-pass posting flatten with size estimate | Faster freeze on very large corpora |
| **Search** | Hot path | Direct subarray posting access in `aggregateTerm` | Lower GC; invasive |

**Intentionally deferred:** embedding `tokenize` / `processTerm` in the snapshot. Raising the `Uint8` term-frequency cap needs a new postings encoding.

For contributor-oriented notes, see [DESIGN_DOCUMENT.md — FrozenMiniSearch](./DESIGN_DOCUMENT.md#frozenminisearch).

---

## Benchmarks

Reproducible comparisons (heap, load time, search latency) live under [`benchmarks/`](benchmarks/README.md):

```bash
npm run benchmark:compare    # terminal report
npm run benchmark:diff       # vs versioned baseline
```

---

## Development

```bash
npm install
npm test
npm run build
```

Use `npm run` for scripts (Yarn 1.x on Node 22 prints `url.parse` deprecation noise when invoking `yarn test` / `yarn build`).

**Publish stable** (updates npm `latest`):

```bash
npm run release:stable
```

**Publish a pre-release** (dist-tag `beta` only):

```bash
npm run release:beta
```

**Requirements:** Node.js **ES2018+**. No browser UMD/CDN build in this fork (Node-only ESM + CJS).

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **This fork** — [yoch/minisearch](https://github.com/yoch/minisearch): `FrozenMiniSearch`, MSv4/MSv3 binary snapshots, shared scoring refactor

Upstream docs: [MiniSearch site](https://lucaong.github.io/minisearch/) · [intro article](https://lucaongaro.eu/blog/2019/01/30/minisearch-client-side-fulltext-search-engine.html)
