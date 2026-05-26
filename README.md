# @yoch/minisearch

**In-memory full-text search for Node.js** — a fork of [MiniSearch](https://github.com/lucaong/minisearch) by [Luca Ongaro](https://github.com/lucaong/minisearch), extended for **production serving**: smaller indexes, faster loads, and a read-only fast path.

> **Current release:** `8.0.0-beta.2` · install with `npm install @yoch/minisearch`

---

## Why this fork?

[MiniSearch](https://github.com/lucaong/minisearch) is excellent for building and querying an index in JavaScript. This fork keeps that API for **mutable** indexing, and adds **`FrozenMiniSearch`** for when the index is built once and queried many times:

| | Mutable `MiniSearch` | `FrozenMiniSearch` |
|---|---------------------|-------------------|
| **Use when** | Documents change (`add`, `remove`, `discard`) | Corpus is fixed, or you reload from disk |
| **Memory** | Maps and nested objects per posting | Flat `Uint32Array` / `Uint8Array` postings |
| **On disk** | `toJSON` / `loadJSON` | **`saveBinary` / `loadBinary`** (MSv2, reads MSv1) |
| **Typical search** | Baseline | Often **~20–35% faster** p50 on the same corpus (see benchmarks) |

Same BM25 scoring, prefix/fuzzy search, `autoSuggest`, and query combinators — frozen indexes aim for **bit-for-bit parity** with `addAll` + `freeze()` on the same options.

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
| Load a snapshot from disk | `FrozenMiniSearch.loadBinary(buffer, options)` |
| Custom assembly pipeline | `buildFrozenFromDocuments`, `assembleFrozen`, `freezeFromMiniSearch` |

`fromDocuments` matches `new MiniSearch(opts).addAll(docs).freeze()` for search ranking on the same corpus and options (`fields`, `tokenize`, `processTerm`, …). Frozen indexes do not support `add` / `remove`.

---

## FrozenMiniSearch in a bit more detail

- **`freeze()`** — snapshot a mutable index into compact typed postings + a radix tree keyed by term index.
- **`fromDocuments()`** — build that structure in one pass (skips nested `Map` postings and radix cloning at freeze time).
- **`saveBinary()` / `loadBinary()`** — MSv2 on write, MSv1 still readable; pass the same `fields` (and custom `tokenize` / `processTerm` if used at build time).
- **Term frequencies** — stored as `Uint8` (max 255 per doc/term); only affects scores for extreme term repetition.
- **`frozenMemoryBreakdown()`** — introspect postings, radix tree, and stored-field footprint.

Advanced exports:

```javascript
import {
  FrozenMiniSearch,
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

**Requirements:** Node.js **ES2018+**. No browser UMD/CDN build in this fork (Node-only ESM + CJS).

---

## Changelog & credits

See [CHANGELOG.md](./CHANGELOG.md).

- **MiniSearch** — [Luca Ongaro](https://github.com/lucaong/minisearch) (MIT)
- **This fork** — [yoch/minisearch](https://github.com/yoch/minisearch): `FrozenMiniSearch`, MSv1/MSv2 binary format, shared scoring refactor

Upstream docs: [MiniSearch site](https://lucaong.github.io/minisearch/) · [intro article](https://lucaongaro.eu/blog/2019/01/30/minisearch-client-side-fulltext-search-engine.html)
