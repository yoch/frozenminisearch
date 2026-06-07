# Changelog

## Unreleased

## v1.0.0 — `@yoch/frozenminisearch`

First stable release on npm. Frozen-only read-only search for Node.js.

### Breaking

- **Binary snapshots** — `loadBinarySync` / `loadBinaryAsync` read only the current frozen binary format; re-build from lucaong JSON if an older snapshot fails to load.
- **Removed `saveBinary()` / `loadBinary()`** — use `saveBinarySync` / `saveBinaryAsync` and `loadBinarySync` / `loadBinaryAsync`.

## v1.0.0-beta.0 — `@yoch/frozenminisearch`

New standalone package (frozen-only) for read-only serving workloads.

### Added

- **`FrozenMiniSearch`** as the default export — `fromDocuments`, builder, `saveBinarySync` / `loadBinarySync`
- **Migration loaders** — `fromMiniSearch`, `fromMiniSearchJson`, `fromMiniSearchSnapshot` (lucaong JSON wire format)
- **Modular benchmarks** — `npm run bench` with profiles `vs-reference`, `regression`, `dev`
- **Parity suite** — `dev/parity/` vs `minisearch` npm (functional invariants)

### Removed from published API

- Mutable `MiniSearch` class and `freeze()` on the fork
- `freezeFromMiniSearch` (use `fromMiniSearchJson`)
- Read-only mutation stubs (`add`, `remove`, …)

### Migration

- `new MiniSearch(opts).addAll(docs)` (lucaong) → `FrozenMiniSearch.fromDocuments(docs, opts)` or `fromMiniSearch(mutable, opts)` — see README
