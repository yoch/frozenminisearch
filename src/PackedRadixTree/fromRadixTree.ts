import { LEAF, validateRadixLeaves, type RadixTree } from '../radixTree'
import { PACKED_NO_VALUE } from './constants'
import { finalizePackedRadixScratch } from './packTermList'
import PackedRadixTree from './PackedRadixTree'

export type FromRadixTreeOptions = {
  /** Skip {@link validateRadixLeaves} when the radix tree comes from a trusted internal builder. */
  skipLeafValidation?: boolean
}

export function fromRadixTree(
  tree: RadixTree<number>,
  termCount: number,
  options?: FromRadixTreeOptions,
): PackedRadixTree {
  if (!options?.skipLeafValidation) {
    validateRadixLeaves(tree, termCount, (detail) => {
      throw new Error(`PackedRadixTree: ${detail}`)
    })
  }
  return packRadixTree(tree, termCount)
}

function packRadixTree(
  tree: RadixTree<number>,
  termCount: number,
): PackedRadixTree {
  type EdgeScratch = { label: string, child: number }
  type NodeScratch = { value: number, leafOrder: number, edges: EdgeScratch[] }
  const nodes: NodeScratch[] = []

  function packNode(node: RadixTree<number>): number {
    const nodeId = nodes.length
    const scratch: NodeScratch = { value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] }
    nodes.push(scratch)
    let childOrder = 0

    for (const [key, val] of node) {
      if (key === LEAF) {
        scratch.value = val as number
        scratch.leafOrder = childOrder
      } else {
        scratch.edges.push({ label: key, child: packNode(val as RadixTree<number>) })
      }
      childOrder++
    }

    return nodeId
  }

  packNode(tree)
  return finalizePackedRadixScratch(nodes, termCount)
}
