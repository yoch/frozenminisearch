import SearchableMap from '../SearchableMap/SearchableMap'
import {
  buildTermTreeSectionColumnar,
  readPackedTermTreeSectionColumnar,
} from '../msv5/packedRadixBinaryMsv5'
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
  const refsAsEntries = Array.from(packed.fuzzyRefs(query, maxDistance))
    .map(({ termIndex, distance }) => [packed.termByIndex(termIndex), termIndex, distance])
  expect(sortedFuzzyTuples(refsAsEntries))
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
  const packedBuf = buildTermTreeSectionColumnar(p)

  // entries() must match Map iteration order exactly (not just as a set).
  expect(Array.from(p.entries())).toEqual(Array.from(m.entries()))
  // Order must survive MSv5 columnar wire round-trip.
  expect(Array.from(readPackedTermTreeSectionColumnar(packedBuf, m.size).entries()))
    .toEqual(Array.from(m.entries()))

  for (const term of gets) {
    expect(p.get(term)).toBe(m.get(term))
  }
  for (const prefix of prefixes) {
    const fromRefs = Array.from(p.prefixRefs(prefix))
      .map(({ termIndex }) => [p.termByIndex(termIndex), termIndex])
    expect(fromRefs).toEqual(Array.from(m.atPrefix(prefix).entries()))
  }
  // fuzzyRefs: same match set as fuzzyGet; iteration order is not compared.
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
    const buf = buildTermTreeSectionColumnar(p)
    const back = readPackedTermTreeSectionColumnar(buf, 0)
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
        const refs = Array.from(p.prefixRefs(prefix))
          .map(({ termIndex }) => [p.termByIndex(termIndex), termIndex])
        expect(refs).toEqual(Array.from(m.atPrefix(prefix).entries()))
      }
      for (const query of ['', 'a', 'ab', 'ba', 'ccc', 'zz']) {
        for (const distance of [0, 1, 2]) {
          expectFuzzyMultiset(p, m, query, distance)
        }
      }
    }
  })

  test('prefixRefs match SearchableMap atPrefix', () => {
    for (const prefix of ['', 'a', 'ac', 'sum', 'xyz']) {
      const fromPacked = Array.from(packed.prefixRefs(prefix))
        .map(({ termIndex }) => [packed.termByIndex(termIndex), termIndex])
      const fromMap = Array.from(map.atPrefix(prefix).entries())
      expect(fromPacked).toEqual(fromMap)
    }
  })

  test('fuzzyRefs match SearchableMap fuzzyGet (same match set)', () => {
    for (const distance of [0, 1, 2, 3]) {
      expectFuzzyMultiset(packed, map, 'acqua', distance)
    }
  })

  test('termByIndex and termLengthByIndex rebuild terms from lazy metadata', () => {
    for (const [term, index] of map.entries()) {
      expect(packed.termByIndex(index)).toBe(term)
      expect(packed.termLengthByIndex(index)).toBe(term.length)
    }
  })

  test('prefixRefs preserve prefix order and lengths', () => {
    const prefix = 'ac'
    const refs = Array.from(packed.prefixRefs(prefix))
    const rebuilt = refs.map(({ termIndex }) => packed.termByIndex(termIndex))
    expect(rebuilt).toEqual(Array.from(map.atPrefix(prefix).entries()).map(([term]) => term))
    for (const ref of refs) {
      expect(ref.length).toBe(packed.termByIndex(ref.termIndex).length)
    }
  })

  test('fuzzyEntries remains parity-equivalent to SearchableMap fuzzyGet', () => {
    for (const distance of [0, 1, 2, 3]) {
      expect(sortedFuzzyTuples(packed.fuzzyEntries('acqua', distance)))
        .toEqual(sortedMapFuzzy(map.fuzzyGet('acqua', distance)))
    }
    const refs = Array.from(packed.fuzzyRefs('acqua', 2))
      .map(({ termIndex, distance }) => [termIndex, distance])
      .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
    const entries = Array.from(packed.fuzzyEntries('acqua', 2))
      .map(([, termIndex, distance]) => [termIndex, distance])
      .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
    expect(refs).toEqual(entries)
  })

  test('prefixEntries remains parity-equivalent to SearchableMap atPrefix', () => {
    for (const prefix of ['', 'a', 'ac', 'sum', 'xyz']) {
      expect(Array.from(packed.prefixEntries(prefix)))
        .toEqual(Array.from(map.atPrefix(prefix).entries()))
    }
    const prefix = 'ac'
    const refs = Array.from(packed.prefixRefs(prefix))
      .map(({ termIndex }) => [packed.termByIndex(termIndex), termIndex])
    expect(Array.from(packed.prefixEntries(prefix))).toEqual(refs)
  })

  test('mid-edge prefix includes full terms', () => {
    const m = SearchableMap.from([['acquire', 0]])
    const p = fromRadixTree(m.radixTree, m.size)
    expect(Array.from(p.prefixRefs('acq')).map(({ termIndex }) => [p.termByIndex(termIndex), termIndex]))
      .toEqual([['acquire', 0]])
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

  test('term tree section round-trips through MSv5 columnar wire', () => {
    const buf = buildTermTreeSectionColumnar(packed)
    const back = readPackedTermTreeSectionColumnar(buf, map.size)
    for (const term of terms) {
      expect(back.get(term)).toBe(packed.get(term))
    }
    expect(Array.from(back.entries())).toEqual(Array.from(packed.entries()))
  })

  test('columnar decoder rejects truncated section', () => {
    const buf = buildTermTreeSectionColumnar(packed)
    expect(() => readPackedTermTreeSectionColumnar(buf.subarray(0, 8), map.size)).toThrow(/too short/)
  })

  test('columnar decoder rejects termCount mismatch', () => {
    const buf = buildTermTreeSectionColumnar(packed)
    expect(() => readPackedTermTreeSectionColumnar(buf, map.size + 1)).toThrow(/termCount mismatch/)
  })
})
