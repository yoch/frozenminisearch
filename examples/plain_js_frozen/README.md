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
```

Binary snapshots (`loadBinarySync`, etc.) are **not** available in the browser build; use Node for MSv5 snapshots.
