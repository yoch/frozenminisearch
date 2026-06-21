# Changelog

## Unreleased

## v1.3.0 — `@yoch/frozenminisearch`

Minor release: portable default compression (`auto` → zlib), browser MSv5 binary snapshots (async native APIs), and Node ↔ browser zlib interoperability.

### Added

- **Browser binary I/O** — `@yoch/frozenminisearch/browser` exposes `saveBinaryAsync` / `loadBinaryAsync` on `Uint8Array` (`raw`, `zlib`, `auto`). No sync binary APIs and no zstd in the browser build.
- **Wire portability layer** — `binaryBytes`, `binaryWireIo`, `fieldLengthMatrixWire`, and browser compression via native `CompressionStream` / `DecompressionStream`.

### Changed

- **`compression: 'auto'`** — always tries zlib (then raw if it does not shrink). zstd remains opt-in via `compression: 'zstd'` on Node 22.15+; existing zstd snapshots still load on Node.

### Improved

- **CI** — cross-runtime smoke tests: Node zlib save → browser load and browser zlib save → Node load.
- **Browser bundle size** — production `dist/browser/index.js` is now `67651` bytes raw, `20944` bytes gzip, and `18667` bytes brotli after removing the sync browser binary path, dropping `fflate`, and minifying the browser bundle.

## v1.2.4 — `@yoch/frozenminisearch`

Patch release: faster frozen search and autoSuggest finalization, simplified AND gate heuristics, and small public exports for advanced callers. No MSv5 wire-format changes.

### Added

- **Public finalize/suggest helpers** — export `finalizeRawSearchResults`, `finalizeSearchResults`, `suggestFromRawResults`, and `suggestFromSearchResults` from the package entry.

### Improved

- **Tied-score finalization** — skip result sorting when every hit shares the same final score (search and suggestions).
- **Frozen search finalize** — copy stored fields in place via `assignStoredFields` (no per-document row allocation for single-column layouts).
- **AutoSuggest without `filter`** — aggregate suggestions from raw query hits instead of materializing full `SearchResult` objects.
- **AND gate heuristics** — pass selective gates as `allowedDocs` consistently; keep prefix/fuzzy on sequential gating via a cheap two-phase posting estimator.
- **CPU-only benchmarks** — `benchmark:finalize` and `benchmark:autosuggest` scripts; clearer reporting when benchmark payloads omit structural metrics.

## v1.2.3 — `@yoch/frozenminisearch`

Patch release: broad-first exact AND / AND_NOT paths, seek-based gated doc-id collection, and README benchmark copy refresh. No API or MSv5 wire-format changes.

### Improved

- **Broad-first exact AND** — on exact-only combined queries where the first branch posting is large and a later branch is selective enough, collect the final doc-id gate by estimated posting length, then score branches in query order (parity with naive score-then-intersect unchanged).
- **Broad-first AND_NOT** — when the positive branch is large and a negated branch is comparably large, collect exclusions first and score the positive branch only on survivors.
- **Gated doc-id collection** — `DocIdGate` lazy views and seek over sorted postings when the gate is much smaller than the posting list (`scoring.ts`, `frozenPostings.ts`).
- **AND gate posting estimate** — skip upfront posting-length estimation on prefix/fuzzy AND branches; keep absolute-gate skip on the sequential path so Divina `AND+fuzzy` stays fast.

## v1.2.2 — `@yoch/frozenminisearch`

Patch release: faster frozen AND scoring on large posting lists (gated seek + posting-ratio gate) and BM25 segment hoisting. No API or MSv5 wire-format changes.

### Improved

- **AND gate posting-ratio** — when the absolute gate cap would disable filtering, pass `allowedDocs` to later AND branches if the gate is small relative to the branch posting length (calibrated: min length 2048, max 25% of posting). Applies to string AND and nested `QueryCombination` AND. Parity with naive score-then-intersect unchanged.
- **Gated posting seek** — on selective AND paths, score gated segments with binary search by doc id instead of scanning full sorted posting lists (same numeric thresholds as the ratio gate; distinct decision point).
- **BM25 IDF hoisting** — compute document-frequency IDF once per posting segment on frozen paths when doc activity filtering is inactive; lowers work on high-frequency AND queries.
- **Posting layout selection** — cost-based choice between dense and sparse frozen posting layouts from field/term statistics at build time.

## v1.2.1 — `@yoch/frozenminisearch`

Patch release: lower search overhead when stored fields are disabled and fewer query-normalization allocations. No API or MSv5 wire-format changes.

### Improved

- **Search without `storeFields`** — skip stored-field reads during scoring and result finalization when the index has no stored fields (`storeFields: []`).
- **String query normalization** — pre-allocated term/spec buffers, hoisted per-query field boosts and match weights, and shared `termToQuerySpec` building (fewer intermediate arrays and closures).

## v1.2.0 — `@yoch/frozenminisearch`

Minor release: configurable MSv5 snapshot compression and Node 20 support.

### Added

- **`SaveBinaryOptions`** — `saveBinarySync()` / `saveBinaryAsync()` accept `{ compression: 'auto' | 'raw' | 'zstd' | 'zlib' }`.
- **`CODEC_ZLIB`** — portable deflate snapshots readable on Node 20+; explicit `compression: 'zlib'` always writes zlib on disk.
- **Exported types** — `BinaryCompression`, `SaveBinaryOptions`.

### Improved

- **`compression: 'auto'`** — one compression pass: zstd when available (Node 22.15+), otherwise zlib on Node 20–22.14, otherwise raw when compression does not strictly shrink the payload (including payloads under 64 B).
- **Node engine** — `>=20` (was `>=22.15`); zstd remains available on Node 22.15+ and is required to read zstd snapshots.

## v1.1.0 — `@yoch/frozenminisearch`

Minor release: MiniSearch JSON wire export and clearer JSON import API. MSv5 binary format unchanged.

### Added

- **`toJSON()`** — export MiniSearch wire snapshots (`serializationVersion: 2`); import via `fromJson` / `fromMiniSearchSnapshot`. Production persistence remains `saveBinarySync`.

### Breaking

- **`fromMiniSearchJson` → `fromJson`** — rename for clearer semantics (JSON import vs binary load). Update call sites: `FrozenMiniSearch.fromMiniSearchJson(json)` → `FrozenMiniSearch.fromJson(json)`.

## v1.0.2 — `@yoch/frozenminisearch`

Patch release: lower retained heap when `storeFields` has one field. No API or MSv5 wire-format changes.

### Improved

- **Single-field `storeFields` at rest** — values live in a dense column instead of one `Record` per document (~75% less retained heap on Divina with `storeFields: ['txt']`; ~1.0 → ~0.3 MB).
- **Binary save/load** — encode and decode skip intermediate row arrays when the in-memory layout or load `storeFields` hint allows direct wire paths (same bytes on disk).
- **Posting slice lookups** — scoring flyweight reuses a scratch buffer instead of allocating `{ offset, length }` per lookup.

## v1.0.1 — `@yoch/frozenminisearch`

Patch release: lower build-time peak memory and migration ergonomics. No API or wire-format changes.

### Improved

- **`FrozenIndexBuilder` peak heap** — incremental typed-array posting accumulators replace per-term `number[][]` scratch; token and term-frequency buffers are reused across `add()` calls.
- **Default tokenization during build** — single-pass field scan when the default splitter is in use (`collectFieldTermFreqsFromFieldInto`).

### Fixed

- **Default tokenizer parity** — leading delimiter produces an empty token (e.g. `::a` → `["", "a"]`), matching MiniSearch `split` behaviour.
- **Named export** — `FrozenMiniSearch` is exported again alongside the default export (ESM and CJS).

## v1.0.0 — `@yoch/frozenminisearch`

First stable release on npm. Frozen-only read-only search for Node.js.

### Breaking

- **Binary snapshots** — `loadBinarySync` / `loadBinaryAsync` read only the current frozen binary format; re-build from MiniSearch JSON if an older snapshot fails to load.
- **Removed `saveBinary()` / `loadBinary()`** — use `saveBinarySync` / `saveBinaryAsync` and `loadBinarySync` / `loadBinaryAsync`.

## v1.0.0-beta.0 — `@yoch/frozenminisearch`

New standalone package (frozen-only) for read-only serving workloads.

### Added

- **`FrozenMiniSearch`** as the default export — `fromDocuments`, builder, `saveBinarySync` / `loadBinarySync`
- **Migration loaders** — `fromMiniSearch`, `fromJson`, `fromMiniSearchSnapshot` (MiniSearch JSON wire format)
- **Modular benchmarks** — `npm run bench` with profiles `vs-reference`, `regression`, `dev`
- **Parity suite** — `dev/parity/` vs `minisearch` npm (functional invariants)

### Removed from published API

- Mutable `MiniSearch` class and `freeze()` on the fork
- `freezeFromMiniSearch` (use `fromJson`)
- Read-only mutation stubs (`add`, `remove`, …)

### Migration

- `new MiniSearch(opts).addAll(docs)` → `FrozenMiniSearch.fromDocuments(docs, opts)` or `fromMiniSearch(mutable, opts)` — see README
