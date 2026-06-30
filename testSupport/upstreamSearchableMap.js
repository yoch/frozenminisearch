import SearchableMap from 'minisearch/SearchableMap'
import { PACKED_NO_VALUE } from '../src/PackedRadixTree/constants.js'
import { finalizePackedRadixScratch } from '../src/PackedRadixTree/packTermList.js'

export default SearchableMap

// MiniSearch/SearchableMap stores leaves under the empty-string edge label.
export const LEAF = ''

export function searchableMapTree(map) {
  return map._tree
}

export function packSearchableMap(map) {
  return packSearchableMapTree(searchableMapTree(map), map.size)
}

export function packSearchableMapEntries(entries) {
  const map = SearchableMap.from(entries)
  return packSearchableMap(map)
}

export function packSearchableMapTree(tree, termCount) {
  const nodes = []

  function packNode(node) {
    const nodeId = nodes.length
    const scratch = { value: PACKED_NO_VALUE, leafOrder: PACKED_NO_VALUE, edges: [] }
    nodes.push(scratch)
    let childOrder = 0

    for (const [key, value] of node) {
      if (key === LEAF) {
        scratch.value = value
        scratch.leafOrder = childOrder
      } else {
        scratch.edges.push({ label: key, child: packNode(value) })
      }
      childOrder++
    }

    return nodeId
  }

  packNode(tree)
  return finalizePackedRadixScratch(nodes, termCount)
}
