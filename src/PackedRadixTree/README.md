# PackedRadixTree

In-memory packed radix tree for string keys with numeric payloads.

- `prefixRefs()` / `fuzzyRefs()`: ref-first primitives for query execution (`termIndex`, `length`, and fuzzy `distance`).
- `entries()`: string iterator used for full materialization and parity checks.
- `termByIndex()` / `termLengthByIndex()`: resolve a ref to its UTF-16 term (or length only).

## Term resolution (frozen search)

- **`termByIndex(termIndex)`** rebuilds the UTF-16 string on every call by walking parent edges (`lazyMetadata.ts`). There is **no cross-request string cache** on the tree instance.
- **`lazyTermMetadata()`** (private) builds parent pointers once per `PackedRadixTree` instance; subsequent `termByIndex` / `termLengthByIndex` calls reuse that structure only.
- **`termLengthByIndex`** returns length without materializing the string (used for prefix/fuzzy weights).

Frozen search uses `prefixRefs` / `fuzzyRefs` plus lazy `termByIndex` only when a posting is scored (match keys, `boostDocument`, etc.).

## Product build path

Document build and MiniSearch JSON import both pack terms through **`packTermsFromList`** in snapshot/insertion order (`terms[i]` → leaf index `i`):

```typescript
import { packTermsFromList } from './PackedRadixTree/packTermList'

const index = packTermsFromList(terms)
```

`FrozenIndexBuilder` dedupes during `add` with a flat `Map<string, number>` and calls `packTermsFromList` once at `freeze`. `fromJSON` collects validated snapshot terms and calls the same primitive after postings are parsed.

## Legacy / test helpers

`fromRadixTree` converts a nested-`Map` radix (`radixTree.ts` / `SearchableMap`) into a packed tree. It remains for parity tests, benchmarks, and low-level encode fallbacks (`treeShape` wire), but is **not** on the product `saveBinary` path.

```typescript
import PackedRadixTree, { fromRadixTree } from './PackedRadixTree'
import { setRadixLeaf, type RadixTree } from '../radixTree'

const radixTree = new Map() as RadixTree<number>
setRadixLeaf(radixTree, 'foo', 0)
setRadixLeaf(radixTree, 'bar', 1)

const tree = fromRadixTree(radixTree, 2)
```

Binary encode/decode for frozen MiniSearch indices: columnar wire in `src/msv5/packedRadixBinaryMsv5.ts`. Leaf invariants are checked by `validateRadixLeaves` in `radixTree.ts` at pack time (`fromRadixTree`) and by `validateFrozenTermIndexLeaves` in `frozenTermIndex.ts` on the packed runtime index.
