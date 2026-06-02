# PackedRadixTree

In-memory packed radix tree for string keys with numeric payloads.

- `entries()` / `prefixEntries()`: same traversal order as `SearchableMap` (`TreeIterator` sibling order, leaf slot position).
- `fuzzyEntries()`: same **set** of `[term, value, distance]` as `SearchableMap#fuzzyGet`; iteration order is implementation-defined.

## Usage

```typescript
import PackedRadixTree, { fromRadixTree } from './PackedRadixTree'
import SearchableMap from './SearchableMap/SearchableMap'

const map = SearchableMap.from([['foo', 0], ['bar', 1]])
const tree = fromRadixTree(map.radixTree, map.size)

tree.get('foo') // 0
Array.from(tree.prefixEntries('f'))
Array.from(tree.fuzzyEntries('fxo', 1))
```

Custom leaf mapping (e.g. frozen index build):

```typescript
fromRadixTree(radixTree, {
  termCount: 0,
  mapLeaf: leaf => assignTermIndex(leaf),
  inferTermCountFromLeaves: true,
})
```

Binary encode/decode for frozen MiniSearch indices: **MSv5** columnar wire in `src/msv5/packedRadixBinaryMsv5.ts`; **deprecated** MSv3/MSv4 recursive DFS in `packedRadixBinary.ts`. Leaf validation is in `frozenTermIndex.ts`.
