# PackedRadixTree

In-memory packed radix tree for string keys with numeric payloads.

- `prefixRefs()` / `fuzzyRefs()`: ref-first primitives for query execution (`termIndex`, `length`, and fuzzy `distance`).
- `entries()`: string iterator used for full materialization and parity checks.
- `termByIndex()` / `termLengthByIndex()`: resolve a ref to its UTF-16 term (or length only).

## Term resolution (frozen search)

- **`visitPrefixRefs` / `visitFuzzyRefs`** pass a `PackedTermCursor` to the visitor. `cursor.term()` concatenates the labels on the traversal's current root-to-leaf edge stack (`termPath.ts`); it is valid only synchronously inside the callback. Frozen search keeps the cursor as the derived term and calls `term()` at most once per posting list, only when a document is actually scored (match keys, `boostDocument`, etc.).
- **`termByIndex(termIndex)`** / **`termLengthByIndex`** rebuild a term from its index by climbing parent pointers. The pointers (`lazyMetadata.ts`, ~3 index arrays) are built on first call and kept on the instance, so these helpers are for tests, benchmarks and tooling; the search path does not call them.

## Deprecated dev helpers

- **`packedPrefixEntries(tree, prefix)`** (`testSupport/packedRadixStringIterators.js`) — string iterator scoped to a prefix (bench/parity, same DFS path as `entries()`). Not shipped in published bundles. Production code should use `visitPrefixRefs` and resolve terms through the visitor cursor.
- Fuzzy string tuples: use `fuzzyRefs` + `termByIndex` (the former `fuzzyEntries` wrapper was removed).

## Product build path

Document build and MiniSearch JSON import both pack terms through **`packTermsFromList`** in snapshot/insertion order (`terms[i]` → leaf index `i`):

```typescript
import { packTermsFromList } from './PackedRadixTree/packTermList'

const index = packTermsFromList(terms)
```

`FrozenIndexBuilder` dedupes during `add` with a flat `Map<string, number>` and calls `packTermsFromList` once at `freeze`. `fromJSON` collects validated snapshot terms and calls the same primitive after postings are parsed.

## Test / benchmark oracle

Parity tests and micro-benchmarks now use upstream `minisearch/SearchableMap`
through [`testSupport/upstreamSearchableMap.js`](../../testSupport/upstreamSearchableMap.js).
That adapter exposes MiniSearch’s internal `_tree` only for repo-local tooling,
and packs it directly into `PackedRadixTree` without any product/runtime call
site.

Binary encode/decode for frozen MiniSearch indices: columnar wire in
`src/msv5/packedRadixBinaryMsv5.ts`. Runtime validation happens on the packed
index via `validateFrozenTermIndexLeaves` in `frozenTermIndex.ts`.
