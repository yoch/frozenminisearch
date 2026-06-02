import SearchableMap from '../SearchableMap/SearchableMap'
import { TREE_NODE_EDGE, TREE_NODE_LEAF } from '../binaryConstants'
import { buildTermTreeSection } from '../binaryStructures'
import { buildTermTreeSectionFromPacked, readPackedTermTreeSection } from '../packedRadixBinary'
import { validateFrozenTermIndexLeaves } from '../frozenTermIndex'
import { sortedFuzzyTuples, sortedMapFuzzy } from '../../testSupport/fuzzyParity.js'
import PackedRadixTree, { fromRadixTree } from './index'

const terms = ['summer', 'acqua', 'aqua', 'acquire', 'poisson', 'qua']
const keyValues = terms.map((key, i) => [key, i])
const map = SearchableMap.from(keyValues)
const packed = fromRadixTree(map.radixTree, map.size)

test('fromRadixTree with mapLeaf options matches termCount form', () => {
  const m = SearchableMap.from(keyValues)
  const viaOptions = fromRadixTree(m.radixTree, {
    termCount: m.size,
    mapLeaf: leaf => leaf,
  })
  expect(Array.from(viaOptions.entries())).toEqual(Array.from(packed.entries()))
})

function expectFuzzyMultiset(packed, map, query, maxDistance) {
  expect(sortedFuzzyTuples(packed.fuzzyEntries(query, maxDistance)))
    .toEqual(sortedMapFuzzy(map.fuzzyGet(query, maxDistance)))
}

function expectPackedParity(entries, probes = {}) {
  const {
    gets = [],
    prefixes = ['', 'a', 'ab', 'ac'],
    fuzzyQueries = ['a'],
    fuzzyDistances = [0, 1, 2],
  } = probes

  const m = SearchableMap.from(entries)
  const p = fromRadixTree(m.radixTree, m.size)
  const packedBuf = buildTermTreeSectionFromPacked(p)
  const mapBuf = buildTermTreeSection(m.radixTree)

  // entries() must match Map iteration order exactly (not just as a set).
  expect(Array.from(p.entries())).toEqual(Array.from(m.entries()))
  // Order must survive both the packed-source and Map-source binary encoders.
  expect(Array.from(readPackedTermTreeSection(packedBuf, 0, packedBuf.length, m.size).entries()))
    .toEqual(Array.from(m.entries()))
  expect(Array.from(readPackedTermTreeSection(mapBuf, 0, mapBuf.length, m.size).entries()))
    .toEqual(Array.from(m.entries()))

  for (const term of gets) {
    expect(p.get(term)).toBe(m.get(term))
  }
  for (const prefix of prefixes) {
    expect(Array.from(p.prefixEntries(prefix))).toEqual(Array.from(m.atPrefix(prefix).entries()))
  }
  // fuzzyEntries: same match set as fuzzyGet; iteration order is not compared.
  for (const query of fuzzyQueries) {
    for (const distance of fuzzyDistances) {
      expectFuzzyMultiset(p, m, query, distance)
    }
  }
}

function allTerms(alphabet, maxLength) {
  const terms = ['']
  function visit(prefix, depth) {
    if (depth === maxLength) return
    for (const char of alphabet) {
      const term = prefix + char
      terms.push(term)
      visit(term, depth + 1)
    }
  }
  visit('', 0)
  return terms
}

describe('PackedRadixTree module', () => {
  test('exact get matches SearchableMap', () => {
    for (const term of terms) {
      expect(packed.get(term)).toBe(map.get(term))
    }
    expect(packed.get('missing')).toBeUndefined()
  })

  test('entries match SearchableMap', () => {
    expect(Array.from(packed.entries())).toEqual(Array.from(map.entries()))
  })

  test('entries and prefixEntries preserve leaf position before child edges', () => {
    expectPackedParity([['a', 0], ['ab', 1], ['ac', 2]])
  })

  test('entries and prefixEntries preserve leaf position after child edges', () => {
    expectPackedParity([['ab', 1], ['ac', 2], ['a', 0]])
  })

  test('empty string term matches SearchableMap', () => {
    expectPackedParity([['', 0], ['a', 1], ['ab', 2]])
  })

  test('leaf interleaved between child edges matches SearchableMap', () => {
    // Inserting 'ab', then 'a', then 'ac' puts the LEAF at slot 1 (between edges).
    expectPackedParity([['ab', 0], ['a', 1], ['ac', 2]], {
      gets: ['a', 'ab', 'ac', 'abc'],
    })
  })

  test('multibyte and surrogate-pair terms match SearchableMap', () => {
    const utf8Terms = ['café', 'cafard', 'caféine', 'naïve', '日本', '日本語', '🚀rocket', '🚀ship']
    const entries = utf8Terms.map((term, i) => [term, i])
    expectPackedParity(entries, {
      gets: [...utf8Terms, 'cafe', 'caf', '日', '🚀', '🚀roc'],
      prefixes: ['', 'caf', 'café', '日本', '🚀', '🚀ro', 'naï'],
      fuzzyQueries: ['cafe', 'café', '日本', '🚀ship'],
      fuzzyDistances: [0, 1, 2],
    })
  })

  test('get returns undefined for a strict prefix that ends mid-edge', () => {
    const m = SearchableMap.from([['acquire', 0]])
    const p = fromRadixTree(m.radixTree, m.size)
    expect(p.get('acq')).toBeUndefined()
    expect(p.get('acquire')).toBe(0)
    expect(p.get('acquired')).toBeUndefined()
  })

  test('empty index packs, validates and round-trips', () => {
    const m = SearchableMap.from([])
    const p = fromRadixTree(m.radixTree, m.size)
    expect(() => validateFrozenTermIndexLeaves(p, 0)).not.toThrow()
    expect(Array.from(p.entries())).toEqual([])
    const buf = buildTermTreeSectionFromPacked(p)
    const back = readPackedTermTreeSection(buf, 0, buf.length, 0)
    expect(Array.from(back.entries())).toEqual([])
  })

  test('deterministic generated corpora match SearchableMap', () => {
    const generatedTerms = allTerms(['a', 'b', 'c'], 3)
    const orderings = [
      generatedTerms,
      [...generatedTerms].reverse(),
      generatedTerms.filter((_, i) => i % 2 === 0).concat(generatedTerms.filter((_, i) => i % 2 === 1)),
    ]

    for (const ordering of orderings) {
      const entries = ordering.map((term, i) => [term, i])
      const m = SearchableMap.from(entries)
      const p = fromRadixTree(m.radixTree, m.size)

      for (const term of generatedTerms.concat(['d', 'aaad'])) {
        expect(p.get(term)).toBe(m.get(term))
      }
      expect(Array.from(p.entries())).toEqual(Array.from(m.entries()))
      for (const prefix of ['', 'a', 'b', 'c', 'aa', 'ab', 'bc', 'zzz']) {
        expect(Array.from(p.prefixEntries(prefix))).toEqual(Array.from(m.atPrefix(prefix).entries()))
      }
      for (const query of ['', 'a', 'ab', 'ba', 'ccc', 'zz']) {
        for (const distance of [0, 1, 2]) {
          expectFuzzyMultiset(p, m, query, distance)
        }
      }
    }
  })

  test('prefixEntries match SearchableMap atPrefix', () => {
    for (const prefix of ['', 'a', 'ac', 'sum', 'xyz']) {
      const fromPacked = Array.from(packed.prefixEntries(prefix))
      const fromMap = Array.from(map.atPrefix(prefix).entries())
      expect(fromPacked).toEqual(fromMap)
    }
  })

  test('fuzzyEntries match SearchableMap fuzzyGet (same match set)', () => {
    for (const distance of [0, 1, 2, 3]) {
      expectFuzzyMultiset(packed, map, 'acqua', distance)
    }
  })

  test('mid-edge prefix includes full terms', () => {
    const m = SearchableMap.from([['acquire', 3]])
    const p = fromRadixTree(m.radixTree, m.size)
    expect(Array.from(p.prefixEntries('acq'))).toEqual([['acquire', 3]])
  })

  test('validateFrozenTermIndexLeaves rejects wrong leaf count', () => {
    expect(() => validateFrozenTermIndexLeaves(packed, map.size + 1)).toThrow(/leaf count/)
  })

  test('validateFrozenTermIndexLeaves rejects duplicate leaf indices', () => {
    const nodeValue = new Uint32Array(packed.nodeValue)
    const leafNodes = Array.from(packed.nodeLeafOrder)
      .map((order, node) => order === 0 ? -1 : node)
      .filter((node) => node >= 0)
    nodeValue[leafNodes[1]] = nodeValue[leafNodes[0]]
    const duplicate = PackedRadixTree.fromData({
      size: packed.size,
      nodeCount: packed.nodeCount,
      edgeCount: packed.edgeCount,
      labelHeap: packed.labelHeap,
      nodeEdgeOffset: packed.nodeEdgeOffset,
      nodeValue,
      nodeLeafOrder: packed.nodeLeafOrder,
      edgeLabelStart: packed.edgeLabelStart,
      edgeLabelLength: packed.edgeLabelLength,
      edgeChild: packed.edgeChild,
    })
    expect(() => validateFrozenTermIndexLeaves(duplicate, map.size)).toThrow(/duplicate leaf index/)
  })

  test('validateFrozenTermIndexLeaves rejects malformed packed arrays', () => {
    const malformed = PackedRadixTree.fromData({
      size: 0,
      nodeCount: 1,
      edgeCount: 1,
      labelHeap: 'a',
      nodeEdgeOffset: new Uint32Array([0, 1]),
      nodeValue: new Uint32Array([0]),
      nodeLeafOrder: new Uint32Array([0]),
      edgeLabelStart: new Uint32Array([0]),
      edgeLabelLength: new Uint16Array([1]),
      edgeChild: new Uint32Array([9]),
    })
    expect(() => validateFrozenTermIndexLeaves(malformed, 0)).toThrow(/child out of bounds/)
  })

  test('rejects edge labels that cannot fit the packed length array', () => {
    const longLabel = 'x'.repeat(0x10000)
    const m = SearchableMap.from([[longLabel, 0]])
    expect(() => fromRadixTree(m.radixTree, m.size)).toThrow(/edge label too long/)
  })

  test('term tree section round-trips through binary', () => {
    const buf = buildTermTreeSectionFromPacked(packed)
    const back = readPackedTermTreeSection(buf, 0, buf.length, map.size)
    for (const term of terms) {
      expect(back.get(term)).toBe(packed.get(term))
    }
    expect(Array.from(back.entries())).toEqual(Array.from(packed.entries()))
  })

  test('Map-encoded term tree section decodes to packed index', () => {
    const buf = buildTermTreeSection(map.radixTree)
    const back = readPackedTermTreeSection(buf, 0, buf.length, map.size)
    for (const term of terms) {
      expect(back.get(term)).toBe(map.get(term))
    }
    expect(Array.from(back.entries())).toEqual(Array.from(map.entries()))
  })

  test('binary decoder rejects duplicate leaves in one node', () => {
    const buf = Buffer.alloc(2 + 5 + 5)
    buf.writeUInt16LE(2, 0)
    buf.writeUInt8(TREE_NODE_LEAF, 2)
    buf.writeUInt32LE(0, 3)
    buf.writeUInt8(TREE_NODE_LEAF, 7)
    buf.writeUInt32LE(1, 8)
    expect(() => readPackedTermTreeSection(buf, 0, buf.length, 1)).toThrow(/duplicate leaf/)
  })

  test('binary decoder rejects empty edge labels', () => {
    const buf = Buffer.alloc(2 + 3)
    buf.writeUInt16LE(1, 0)
    buf.writeUInt8(TREE_NODE_EDGE, 2)
    buf.writeUInt16LE(0, 3)
    expect(() => readPackedTermTreeSection(buf, 0, buf.length, 0)).toThrow(/edge key empty/)
  })

  test('binary decoder rejects unknown node tags', () => {
    const buf = Buffer.alloc(2 + 1)
    buf.writeUInt16LE(1, 0)
    buf.writeUInt8(99, 2)
    expect(() => readPackedTermTreeSection(buf, 0, buf.length, 0)).toThrow(/unknown term tree node tag/)
  })

  test('binary decoder rejects trailing bytes after the root node', () => {
    const buf = Buffer.alloc(2 + 1)
    buf.writeUInt16LE(0, 0)
    expect(() => readPackedTermTreeSection(buf, 0, buf.length, 0)).toThrow(/trailing bytes/)
  })

  test('binary decoder rejects a truncated child count', () => {
    const buf = Buffer.alloc(1)
    expect(() => readPackedTermTreeSection(buf, 0, buf.length, 0)).toThrow(/child count truncated/)
  })
})
