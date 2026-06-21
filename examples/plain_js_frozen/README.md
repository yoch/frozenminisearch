# FrozenMiniSearch browser example

Plain JavaScript demo of the **browser build** (`@yoch/frozenminisearch/browser`).

**Hosted:** [yoch.github.io/frozenminisearch/demo/](https://yoch.github.io/frozenminisearch/demo/)

## Prerequisites

Build the browser bundle and copy assets into this folder:

```bash
yarn build
node scripts/prepare-frozen-demo.cjs
```

## Start locally

1. Serve the repository root over HTTP, e.g. `python3 -m http.server 8000`.
2. Open `http://localhost:8000/examples/plain_js_frozen/`.

The page loads `billboard_1965-2015.json` and builds a frozen index with `fromDocuments`.

## Bundlers

In your app, import the browser entry explicitly:

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch/browser'

const index = FrozenMiniSearch.fromDocuments(documents, options)

// Optional: load a pre-built zlib snapshot from your CDN
const buf = new Uint8Array(await (await fetch('/path/to/index.frozen')).arrayBuffer())
const loaded = await FrozenMiniSearch.loadBinaryAsync(buf, options)
```

The browser build supports **async** binary only (`saveBinaryAsync` / `loadBinaryAsync` on `Uint8Array`, codecs `raw` / `zlib` / `auto`). Use Node to produce CDN snapshots with `compression: 'zlib'` (or rely on `auto`, which defaults to zlib).
