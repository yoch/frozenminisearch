/**
 * Smallest unsigned typed array that can hold the structure's indices. Widths
 * are chosen adaptively at build time (`packedIndexArray` in `layout.ts`); reads via
 * `arr[i]` are width-agnostic, so query code never branches on the concrete type.
 */
export type PackedIndexArray = Uint8Array | Uint16Array | Uint32Array

export type PackedTermRef = {
  termIndex: number
  length: number
}

export type PackedFuzzyRef = PackedTermRef & {
  distance: number
}

/** In-memory packed string radix map (term → payload). */
export interface PackedStringRadixMap<V = number> {
  readonly size: number
  get(term: string): V | undefined
  entries(): Iterable<[string, V]>
  prefixRefs(prefix: string): Iterable<PackedTermRef>
  /** Lazy generator; see `packedRadixFuzzyRefs` in `fuzzy.ts` for rationale. */
  fuzzyRefs(term: string, maxDistance: number): Iterable<PackedFuzzyRef>
  termByIndex(termIndex: number): string
  termLengthByIndex(termIndex: number): number
  /** @deprecated Internal benchmark/compat wrapper. Prefer `prefixRefs` + `termByIndex`. */
  prefixEntries(prefix: string): Iterable<[string, V]>
  /**
   * @deprecated Internal benchmark/compat wrapper. Prefer `fuzzyRefs` + `termByIndex`.
   *
   * Fuzzy matches for `term` within `maxDistance` edit distance. Yields every matching
   * `[term, value, distance]`; iteration order is implementation-defined (compare sets, not order).
   */
  fuzzyEntries(term: string, maxDistance: number): Iterable<[string, V, number]>
  packedByteLength(): number
  packedNodeCount(): number
  packedEdgeCount(): number
}

export interface PackedRadixTreeData {
  readonly size: number
  readonly nodeCount: number
  readonly edgeCount: number
  readonly labelHeap: string
  /**
   * CSR edge offsets, length `nodeCount + 1`. Node `n` owns edges
   * `[nodeEdgeOffset[n], nodeEdgeOffset[n + 1])`; the final entry equals
   * `edgeCount`. Replaces the former `nodeFirstEdge`/`nodeEdgeCount` pair: edges
   * are laid out contiguously in node order, so the per-node first index is just
   * the prefix sum of the counts and need not be stored separately.
   */
  readonly nodeEdgeOffset: PackedIndexArray
  /**
   * Leaf payload per node (term index for a frozen index). Meaningful only when
   * the node has a leaf, i.e. `nodeLeafOrder[n] !== 0`; otherwise the cell is
   * unused (stored as `0`). Width adapts to the largest payload.
   */
  readonly nodeValue: PackedIndexArray
  /**
   * Leaf slot among a node's siblings, encoded as `slot + 1` with `0` meaning
   * "no leaf". This avoids a wide sentinel: the column adapts to the largest
   * child count instead of forcing `Uint32`. Decode with {@link decodeLeafSlot}.
   */
  readonly nodeLeafOrder: PackedIndexArray
  readonly edgeLabelStart: PackedIndexArray
  readonly edgeLabelLength: PackedIndexArray
  readonly edgeChild: PackedIndexArray
}
