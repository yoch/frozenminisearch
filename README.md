# @yoch/minisearch

**In-memory full-text search for Node.js** — a fork of [MiniSearch](https://github.com/lucaong/minisearch) by [Luca Ongaro](https://github.com/lucaong/minisearch), extended for **production serving**: smaller indexes, faster loads, and a read-only fast path.

> **Current release:** `8.4.0-beta.1` (pre-release) · stable `8.3.3` on npm `latest` · try beta: `npm install @yoch/minisearch@beta`

---

## Why this fork?

[MiniSearch](https://github.com/lucaong/minisearch) is excellent for building and querying an index in JavaScript. This fork keeps that familiar API for **mutable** indexing and adds **`FrozenMiniSearch`** — born from a single goal, *shrink the in-memory index*, for when the corpus is built once and queried many times:

| | Mutable `MiniSearch` | `FrozenMiniSearch` |
|---|---------------------|-------------------|
| **Use when** | Documents change (`add`, `remove`, `discard`) | Corpus is fixed, or you reload from disk |
| **Memory** | Maps and nested objects per posting | Flat `Uint32Array` doc ids + adaptive `Uint8`/`Uint16` term freqs |
| **On disk** | `toJSON` / `loadJSON` | **`saveBinarySync` / `loadBinarySync`** (MSv5) |
| **Typical search** | Baseline | Often **~20–45% faster** p50 on the same corpus (see [benchmarks](#benchmarks)) |

Same BM25 scoring, prefix/fuzzy search, `autoSuggest`, and query combinators — frozen indexes aim for **search ranking parity** with `addAll` + `freeze()` when built with the same options. Term frequencies use **adaptive width** (`Uint8` when all values ≤ 255, otherwise `Uint16`), clamped at **65535** per document/field on frozen paths. MSv5 snapshots without `FLAG_FREQ_U16` remain `Uint8` (legacy).

---

## Quick start

```bash
npm install @yoch/minisearch
```

**One-shot frozen index** (no mutable step):

```javascript
import { FrozenMiniSearch } from '@yoch/minisearch'

const options = { fields: ['title', 'text'], storeFields: ['title'] }
const index = FrozenMiniSearch.fromDocuments(documents, options)
index.search('ishmael', { prefix: true })
index.autoSuggest('zen')

// Persist and reload
const buf = index.saveBinarySync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
```

**Mutable index, then freeze** (incremental build):

```javascript
import MiniSearch, { FrozenMiniSearch } from '@yoch/minisearch'

const ms = new MiniSearch({ fields: ['title', 'text'] })
ms.addAll(documents)

const frozen = ms.freeze()   // immutable snapshot
const buf = frozen.saveBinarySync()
```

Both ESM and CommonJS are supported:

```javascript
// ESM
import MiniSearch, { FrozenMiniSearch } from '@yoch/minisearch'

// CommonJS
const MiniSearch = require('@yoch/minisearch')
const { FrozenMiniSearch } = require('@yoch/minisearch')
```

---

## MiniSearch (mutable)

The familiar upstream API — unchanged. Field boosts, fuzzy/prefix, nested queries, `AND` / `OR` / `AND_NOT`, filters, `autoSuggest`, vacuum after `discard`, etc.

```javascript
import MiniSearch from '@yoch/minisearch'

const miniSearch = new MiniSearch({ fields: ['title', 'text'] })
miniSearch.addAll(documents)
miniSearch.search('zen art motorcycle')
```

Call `freeze()` on any mutable index to get the read-only structure described below.

---

## Building a frozen index

Pick the entry point that matches how your documents arrive:

| Goal | API |
|------|-----|
| Live index that changes over time | `MiniSearch` → `freeze()` when you need read-only serving |
| Fixed corpus, build frozen directly | **`FrozenMiniSearch.fromDocuments(documents, options)`** |
| Build doc-by-doc (no `documents[]` buffer) | **`createFrozenIndexBuilder(options)`** → `.add(doc)` → **`freezeFrozenIndexBuilder(builder)`** |
| Async stream of documents | **`FrozenMiniSearch.fromAsyncIterable(iterable, options)`** |
| Custom assembly pipeline | `buildFrozenFromDocuments`, `assembleFrozen`, `freezeFromMiniSearch` |

All paths produce the same structure — compact typed postings plus a packed radix term tree. `fromDocuments` builds it in a single pass (lower peak memory than `freeze()`-after-`addAll`), and `fromDocuments` matches `new MiniSearch(opts).addAll(docs).freeze()` for search ranking on the same corpus and options (`fields`, `tokenize`, `processTerm`, …). Frozen indexes do not support `add` / `remove`.

**Builder** (doc-by-doc, no intermediate array):

```javascript
import { createFrozenIndexBuilder, freezeFrozenIndexBuilder } from '@yoch/minisearch'

const builder = createFrozenIndexBuilder(options, {
  estimatedDocumentCount: rows.length  // optional: pre-allocates per-doc arrays
})
for (const doc of rows) {
  builder.add(doc)
}
const frozen = freezeFrozenIndexBuilder(builder)
```

**Async stream** (documents indexed as they arrive):

```javascript
import { createReadStream } from 'node:fs'
import { parse } from 'csv-parse'
import { FrozenMiniSearch } from '@yoch/minisearch'

async function buildFromCsv (path, options) {
  async function * documents () {
    const parser = createReadStream(path).pipe(parse({ columns: true }))
    for await (const row of parser) {
      yield { id: row.id, title: row.title, /* … */ }
    }
  }
  return FrozenMiniSearch.fromAsyncIterable(documents(), options)
}
```

**From a mutable index:** if you used `discard()` on a `MiniSearch` index, run `vacuum()` before `freeze()` to shrink the snapshot; search parity is still expected without vacuum, but the binary may retain sparse slots.

**Introspection:** `frozenMemoryBreakdown()` reports the postings, radix tree, and stored-field footprint (estimates only; not exact heap accounting).

Advanced exports for custom pipelines:

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

## Binary snapshots (save / load)

`FrozenMiniSearch` persists to a compact **MSv5** binary format (optionally zstd-compressed) — much smaller and faster to load than JSON.

```javascript
const buf = index.saveBinarySync()              // or: await index.saveBinaryAsync()
const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
//             FrozenMiniSearch.loadBinaryAsync(buf, options)  // lower peak RAM on zstd payloads
```

- **What it stores** — field names and `storeFields` payloads are embedded, so the `options.fields` argument on load is **optional** (names come from the file); if you pass it, it must match exactly. **`tokenize` / `processTerm` are not stored** — pass the same functions at load time when you customized indexing.
- **Compatibility** — older **MSv3** / **MSv4** files still load; re-save with `saveBinarySync()` to upgrade to MSv5.
- **Deprecated aliases** — `saveBinary()` and `loadBinary()` still map to the sync implementations and emit a one-time `DeprecationWarning`; call `*Sync()` or `*Async()` explicitly.
- **Node requirement** — **22.15.0+** (declared in `engines`), where `node:zlib` gained the zstd APIs. On older runtimes the save methods fall back to a raw (uncompressed) payload, and reading a zstd snapshot throws a clear error.

---

## Benchmarks

Cutting memory was the original motivation, and the win is real: the index structure shrinks **~10–100× versus the mutable index** across every scenario below. Numbers from [`baselines/reference.json`](benchmarks/baselines/reference.json) — Node.js v22.x, package 8.4.0-beta.1, median of 3 runs × 15 searches (fixed batch per query; see [benchmarks/README.md](benchmarks/README.md)).

| Scenario | Docs | Index heap¹ | File size (binary vs JSON) | Load time (binary vs JSON) | Search p50 gain |
|----------|------|------------|--------------------------|--------------------------|----------------|
| Divina Commedia (with storeFields) | 14k, 1 field | −90% | −73% | −77% | ~35% avg |
| 100k documents | 100k, 1 field | −95% | −88% | −93% | ~43% avg |
| Many fields | 2k, 10 fields | −99% | −92% | −92% | ~45% avg |

¹ **Index heap** is the index structure only (postings + radix tree), estimated from `process.memoryUsage()` after GC — not exact allocator accounting. This is where the savings are largest and most consistent (≈90–99% smaller). The one caveat: when `storeFields` payloads are big, the stored JSON dominates the resident footprint, so *total* heap savings shrink (down to ~20% in extreme cases) — but file size and load time still improve regardless of `storeFields` size.

Search gains are highest on exact and `AND` queries (−30 to −60 %); prefix can be slower on small corpora where the posting list fits in cache. See [`benchmarks/`](benchmarks/README.md) for per-query breakdowns.

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

### Release checklist

1. Bump `version` in `package.json` and update [CHANGELOG.md](./CHANGELOG.md).
2. `npm test` and `npm run build` (also run by `prepublishOnly` on publish).
3. If README or public API changed: `npm run build-docs` (syncs `docs/media/` from root changelog, design doc, and benchmarks; then TypeDoc + demo), then commit `docs/` HTML (do not edit `docs/index.html` by hand). Files under `docs/media/` are generated and gitignored — GitHub Pages is deployed via the **Docs** workflow (`.github/workflows/docs.yml`).
4. Commit version + changelog (+ docs if step 3) on a clean tree.
5. Publish:
   - **Stable** (`latest`): `npm run release:stable`
   - **Pre-release** (`beta` tag only): `npm run release:beta`

For implementation details and contributor notes, see [DESIGN_DOCUMENT.md](./DESIGN_DOCUMENT.md).

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **This fork** — [yoch/minisearch](https://github.com/yoch/minisearch): `FrozenMiniSearch`, packed radix term index (`PackedRadixTree`), MSv5 binary snapshots (+ MSv3/MSv4 read-compat), shared scoring refactor

Upstream docs: [MiniSearch site](https://lucaong.github.io/minisearch/) · [intro article](https://lucaongaro.eu/blog/2019/01/30/minisearch-client-side-fulltext-search-engine.html)
