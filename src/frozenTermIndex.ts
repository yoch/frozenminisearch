/** Read-only term → term-index map used by {@link FrozenMiniSearch}. */
export interface FrozenTermIndex {
  readonly size: number
  get(term: string): number | undefined
  prefixEntries(prefix: string): Iterable<[string, number]>
  fuzzyEntries(term: string, maxDistance: number): Iterable<[string, number, number]>
  entries(): Iterable<[string, number]>
  /** Bytes used by the packed representation (typed arrays + label heap). */
  packedByteLength(): number
  /** Node count in the packed graph (for memory breakdown). */
  packedNodeCount(): number
  /** Edge count in the packed graph (for memory breakdown). */
  packedEdgeCount(): number
  validateLeaves(termCount: number): void
}
