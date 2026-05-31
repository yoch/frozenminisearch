/**
 * Smallest unsigned typed array that can hold the structure's indices. Widths
 * are chosen adaptively at build time (see {@link packedIndexArray}); reads via
 * `arr[i]` are width-agnostic, so query code never branches on the concrete type.
 */
export type PackedIndexArray = Uint8Array | Uint16Array | Uint32Array

/** In-memory packed string radix map (term → payload). */
export interface PackedStringRadixMap<V = number> {
  readonly size: number
  get(term: string): V | undefined
  prefixEntries(prefix: string): Iterable<[string, V]>
  fuzzyEntries(term: string, maxDistance: number): Iterable<[string, V, number]>
  entries(): Iterable<[string, V]>
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
  readonly nodeValue: Uint32Array
  readonly nodeLeafOrder: Uint32Array
  readonly edgeLabelStart: PackedIndexArray
  readonly edgeLabelLength: Uint16Array
  readonly edgeChild: PackedIndexArray
}
