# PackedRadixTree

In-memory packed radix tree for string keys with numeric payloads. Same traversal semantics as `SearchableMap` (reverse sibling order, leaf slot position).

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

Binary encode/decode for frozen MiniSearch indices lives in `packedRadixBinary.ts` (minisearch-specific MSv3/MSv4 section format). Leaf validation for frozen indices is in `frozenTermIndex.ts`.
