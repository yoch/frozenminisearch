import { decodeLeafSlot, edgeOffsetAtSlot, packedNodeChildCount } from './layout'
import type PackedRadixTree from './PackedRadixTree'
import { labelSlice } from './strings'

type EmitFrame = {
  node: number
  slot: number
  first: number
  leafSlot: number
  prefix: string
}

function pushEmitFrame(frames: EmitFrame[], tree: PackedRadixTree, node: number, prefix: string): void {
  const first = tree.nodeEdgeOffset[node]
  const edgeCount = tree.nodeEdgeOffset[node + 1] - first
  const leafSlot = decodeLeafSlot(tree.nodeLeafOrder[node])
  const totalCount = packedNodeChildCount(edgeCount, leafSlot >= 0)
  frames.push({ node, slot: totalCount - 1, first, leafSlot, prefix })
}

/**
 * Depth-first string traversal matching {@link SearchableMap}'s `TreeIterator`.
 * Used by `entries()`.
 */
export function* emitSubtree(
  tree: PackedRadixTree,
  startNode: number,
  startPrefix: string,
): IterableIterator<[string, number]> {
  const heap = tree.labelHeap
  const frames: EmitFrame[] = []
  pushEmitFrame(frames, tree, startNode, startPrefix)

  while (frames.length) {
    const frame = frames[frames.length - 1]
    if (frame.slot < 0) {
      frames.pop()
      continue
    }

    const slot = frame.slot--
    const edgeOffset = edgeOffsetAtSlot(slot, frame.leafSlot)
    if (edgeOffset < 0) {
      yield [frame.prefix, tree.nodeValue[frame.node]]
      continue
    }

    const ei = frame.first + edgeOffset
    const start = tree.edgeLabelStart[ei]
    const len = tree.edgeLabelLength[ei]
    const childPrefix = frame.prefix + labelSlice(heap, start, len)
    pushEmitFrame(frames, tree, tree.edgeChild[ei], childPrefix)
  }
}
