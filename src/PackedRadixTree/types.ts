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
  readonly nodeFirstEdge: Uint32Array
  readonly nodeEdgeCount: Uint32Array
  readonly nodeValue: Uint32Array
  readonly nodeLeafOrder: Uint32Array
  readonly edgeLabelStart: Uint32Array
  readonly edgeLabelLength: Uint16Array
  readonly edgeChild: Uint32Array
  readonly edgeFirstChar: Uint16Array
}
