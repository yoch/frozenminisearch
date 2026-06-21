# FrozenMiniSearch browser example

Plain JavaScript demo of the **browser build** (`@yoch/frozenminisearch/browser`).

## Prerequisites

Build the browser bundle from the repository root:

```bash
yarn build
```

## Start

1. `cd` to this directory (or serve the whole repo).
2. Start an HTTP server, e.g. `python3 -m http.server 8000` from the repo root.
3. Open `http://localhost:8000/examples/plain_js_frozen/`.

The demo loads Billboard JSON from `examples/plain_js/` and builds a frozen index with `fromDocuments`.

## Bundlers

In your app, import the browser entry explicitly:

```javascript
import FrozenMiniSearch from '@yoch/frozenminisearch/browser'

const index = FrozenMiniSearch.fromDocuments(documents, options)

// Optional: load a pre-built zlib snapshot from your CDN
const buf = new Uint8Array(await (await fetch('/path/to/index.frozen')).arrayBuffer())
const loaded = await FrozenMiniSearch.loadBinaryAsync(buf, options)
```

The browser build supports **async** binary only (`saveBinaryAsync` / `loadBinaryAsync` on `Uint8Array`, codecs `raw` / `zlib` / `auto`). Use Node to produce CDN snapshots with `compression: 'zlib'` (or rely on `auto`, which now defaults to zlib).
