import { labelSlice } from './strings'
import type { PackedRadixTreeData, PackedTermCursor } from './types'

/**
 * Root-to-node edge stack maintained by a traversal. `term()` concatenates the
 * labels on demand, so terms are only materialized when a visitor asks for them,
 * without the parent-pointer arrays `termByIndex` needs.
 */
export class PackedTermPath implements PackedTermCursor {
  /** Text of the path from the root to the traversal start node. */
  base = ''
  readonly edges: number[] = []
  depth = 0
  inUse = false

  constructor(private readonly tree: PackedRadixTreeData) {}

  term(): string {
    const { labelHeap, edgeLabelStart, edgeLabelLength } = this.tree
    let term = this.base
    for (let d = 0; d < this.depth; d++) {
      const ei = this.edges[d]
      term += labelSlice(labelHeap, edgeLabelStart[ei], edgeLabelLength[ei])
    }
    return term
  }
}

/**
 * Per-tree reusable path. Keeping one instance alive also keeps its hidden class
 * alive: with only short-lived paths, a full GC collects that class and discards
 * the optimized traversal code that embeds it.
 */
export class PackedTermPathPool {
  private readonly shared: PackedTermPath

  constructor(private readonly tree: PackedRadixTreeData) {
    this.shared = new PackedTermPath(tree)
  }

  /** Nested traversals (a visitor that searches the same tree) get a private path. */
  acquire(base: string): PackedTermPath {
    const path = this.shared.inUse ? new PackedTermPath(this.tree) : this.shared
    path.inUse = true
    path.base = base
    path.depth = 0
    return path
  }

  release(path: PackedTermPath): void {
    path.inUse = false
  }
}
