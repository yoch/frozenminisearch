# Parity contract — `@yoch/frozenminisearch` vs MiniSearch

## Functional invariants (CI)

- Same result `id` ordering and scores (`toBeCloseTo`, precision 6) for identical `(query, searchOptions)`.
- Same `terms` sets and `match` keys per hit (`terms` array order may differ when scores tie).
- `autoSuggest` scores and term sets within tolerance (suggestion phrase order follows `terms`).
- Options: prefix, fuzzy, wildcard, AND / OR / AND_NOT, filters, boosts, field restrictions.

## Known acceptable drift

- Wildcard: only `FrozenMiniSearch.wildcard` is recognized (strict identity).
  `MiniSearch.wildcard` from the `minisearch` package is a distinct symbol and
  is no longer accepted; callers should use the package's own wildcard.
- Float32 `avgFieldLength` vs Float64 upstream.
- Term frequency clamp (`Uint8` / `Uint16`) on frozen paths vs unbounded maps upstream.
- `fromJson` / snapshot rebuild: MiniSearch radix sibling order can differ from a live instance after `toJSON` → different `terms` ordering for prefix-heavy hits (scores unchanged).
- Node.js and browser search/autosuggest parity for `search`, `autoSuggest`, filters, boosts, prefix/fuzzy (browser via `dist/browser` smoke tests).
- Browser binary snapshots: `saveBinaryAsync` / `loadBinaryAsync` on `Uint8Array` with `raw`, `zlib`, or `auto`; zlib round-trip **Node → browser** and **browser → Node** on a representative corpus.
- zstd write/read remains Node.js-only; browser binary snapshots support only `raw`, `zlib`, and `auto`.

## Out of scope (not blocking)

- PackedRadixTree vs SearchableMap iteration order.
- Internal AND-gate implementation details (oracle: gated vs naive on **frozen** only).

## Reference

Upstream reference: `minisearch` npm package (devDependency), not the former in-tree fork.
