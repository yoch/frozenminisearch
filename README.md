# @yoch/minisearch

**In-memory full-text search for Node.js** — a fork of [MiniSearch](https://github.com/lucaong/minisearch) by [Luca Ongaro](https://github.com/lucaong/minisearch), extended for **production serving**: smaller indexes, faster loads, and a read-only fast path.

> **Current release:** `8.0.0-beta.3` · install with `npm install @yoch/minisearch`

---

## Why this fork?

[MiniSearch](https://github.com/lucaong/minisearch) is excellent for building and querying an index in JavaScript. This fork keeps that API for **mutable** indexing, and adds **`FrozenMiniSearch`** for when the index is built once and queried many times:

| | Mutable `MiniSearch` | `FrozenMiniSearch` |
|---|---------------------|-------------------|
| **Use when** | Documents change (`add`, `remove`, `discard`) | Corpus is fixed, or you reload from disk |
| **Memory** | Maps and nested objects per posting | Flat `Uint32Array` / `Uint8Array` postings |
| **On disk** | `toJSON` / `loadJSON` | **`saveBinary` / `loadBinary`** (MSv2, reads MSv1) |
| **Typical search** | Baseline | Often **~20–35% faster** p50 on the same corpus (see benchmarks) |

Same BM25 scoring, prefix/fuzzy search, `autoSuggest`, and query combinators — frozen indexes aim for **search ranking parity** with `addAll` + `freeze()` when built with the same options. Term frequencies are stored as `Uint8` (max **255** per document/field); extreme repetition can cause a small score drift versus the mutable index.

---

## Quick start

```bash
npm install @yoch/minisearch
# or pin the beta channel:
# npm install @yoch/minisearch@beta
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
- **`saveBinary()` / `loadBinary()`** — MSv2 on write, MSv1 still readable (legacy read-only). On reload, pass the **exact same** `fields` array as at build time (same names, same count). Custom `tokenize` / `processTerm` are **not** stored in the binary snapshot — provide the same functions at load time if you customized them. `storeFields` data is embedded in the snapshot.
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

### Already in this release

Recent consolidation work (MSv2 hardening) includes:

| Area | Change | Effect |
|------|--------|--------|
| **Binary load** | Structural validation in `decodeFrozenSnapshot` / `validateFrozenSnapshot` | Corrupt or truncated snapshots fail fast with `Invalid frozen index: …` |
| **`loadBinary`** | `fields` must match the snapshot exactly (no silent subset) | Misconfigured reload cannot return partial results |
| **`saveBinary`** | Single pre-allocated buffer instead of `Buffer.concat` chains | Lower peak memory while serializing |
| **Search** | Per-query cache for `fieldTermDataFor(termIndex)` | Fewer allocations on prefix/fuzzy multi-term queries |
| **Weights** | Same default merge as `MiniSearch` | Avoids future drift if library defaults change |

Measure regressions with [`benchmarks/`](benchmarks/README.md) (`freezeMs`, `saveBinary`, `loadBinary`, search p50, heap frozen).

### Suggested follow-ups (not implemented yet)

These came out of the release review. They are **optional** improvements for a future format (e.g. **MSv3**) or API revision — not required for the current beta.

| Priority | Topic | Idea | Trade-off |
|----------|-------|------|-----------|
| **Format** | Integrity | CRC32 or hash in the MSv2 reserved header bytes | Detect bit rot / partial writes; breaks on-disk compat unless versioned |
| **Format** | Metadata | Serialize `externalIds`, `storedFields`, and the term tree in binary instead of JSON in the meta section | Smaller disk + faster `loadBinary`; larger implementation effort |
| **Format** | Term dictionary | Drop runtime `_terms[]` duplicate; rebuild from the radix tree only when saving, or store the tree once without separate `terms` + `treeShape` | Saves heap on large indexes; more complex encode/decode |
| **API** | `loadBinaryAsync` | Chunked/async load like `loadJSONAsync` | Better cold start for huge indexes on Node; new public API |
| **API** | Input types | Accept `Uint8Array` as well as `Buffer` on `loadBinary` | Slightly broader runtime support |
| **Load (MSv1)** | Legacy decode | Pre-size posting buffers and fill `Uint32Array`/`Uint8Array` directly (avoid `number[]` scratch) | Faster migration from old MSv1 files only |
| **Build** | `freeze` / builder | One-pass posting flatten with estimated total posting count | Faster `freeze()` / `fromDocuments` on very large corpora |
| **Search** | Wildcard | Iterate only active document slots after dense remap | Faster `MiniSearch.wildcard` when the index had many `discard`s before freeze |
| **Observability** | `memoryBreakdown()` | Option to skip `JSON.stringify` estimates for stored fields | Cheaper introspection in hot paths |
| **Search** | Hot path | Reuse posting views across terms without even the per-query object cache (e.g. direct subarray in `aggregateTerm`) | More invasive; benchmark before shipping |

**Intentionally deferred:** embedding `tokenize` / `processTerm` in the binary snapshot (callers must pass the same functions at load time if customized). Changing the `Uint8` term-frequency cap would require a new postings encoding, not a small patch.

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

**Publish a beta** (`publishConfig.tag` is `beta`, so use the release script to also move `latest`):

```bash
npm run release:beta
```

**Requirements:** Node.js **ES2018+**. No browser UMD/CDN build in this fork (Node-only ESM + CJS).

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **This fork** — [yoch/minisearch](https://github.com/yoch/minisearch): `FrozenMiniSearch`, MSv1/MSv2 binary format, shared scoring refactor

Upstream docs: [MiniSearch site](https://lucaong.github.io/minisearch/) · [intro article](https://lucaongaro.eu/blog/2019/01/30/minisearch-client-side-fulltext-search-engine.html)
