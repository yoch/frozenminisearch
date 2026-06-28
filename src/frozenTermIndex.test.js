import PackedRadixTree from './PackedRadixTree'
import { packTermsFromList } from './PackedRadixTree/packTermList'
import { validateFrozenTermIndexLeaves } from './frozenTermIndex'

function cloneTree(tree, mutate) {
  const data = {
    size: tree.size,
    nodeCount: tree.nodeCount,
    edgeCount: tree.edgeCount,
    labelHeap: tree.labelHeap,
    nodeEdgeOffset: tree.nodeEdgeOffset,
    nodeValue: new Uint32Array(tree.nodeValue),
    nodeLeafOrder: new Uint32Array(tree.nodeLeafOrder),
    edgeLabelStart: tree.edgeLabelStart,
    edgeLabelLength: new Uint16Array(tree.edgeLabelLength),
    edgeChild: new Uint32Array(tree.edgeChild),
  }
  mutate(data)
  return PackedRadixTree.fromData(data)
}

describe('validateFrozenTermIndexLeaves', () => {
  const termCount = 2
  let base

  beforeEach(() => {
    base = packTermsFromList(['alpha', 'beta'])
  })

  test('accepts a valid packed term index', () => {
    expect(() => validateFrozenTermIndexLeaves(base, termCount)).not.toThrow()
  })

  test('rejects array length mismatches', () => {
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeEdgeOffset = new Uint32Array(d.nodeCount) }),
      termCount,
    )).toThrow(/array length mismatch/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeValue = new Uint32Array(d.nodeCount - 1) }),
      termCount,
    )).toThrow(/array length mismatch/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeLeafOrder = new Uint32Array(d.nodeCount - 1) }),
      termCount,
    )).toThrow(/array length mismatch/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.edgeLabelStart = new Uint32Array(d.edgeCount - 1) }),
      termCount,
    )).toThrow(/array length mismatch/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.edgeLabelLength = new Uint16Array(d.edgeCount - 1) }),
      termCount,
    )).toThrow(/array length mismatch/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.edgeChild = new Uint32Array(d.edgeCount - 1) }),
      termCount,
    )).toThrow(/array length mismatch/)
  })

  test('rejects missing root node', () => {
    const empty = PackedRadixTree.fromData({
      size: 0,
      nodeCount: 0,
      edgeCount: 0,
      labelHeap: '',
      nodeEdgeOffset: new Uint32Array([0]),
      nodeValue: new Uint32Array(0),
      nodeLeafOrder: new Uint32Array(0),
      edgeLabelStart: new Uint32Array(0),
      edgeLabelLength: new Uint16Array(0),
      edgeChild: new Uint32Array(0),
    })
    expect(() => validateFrozenTermIndexLeaves(empty, 0)).toThrow(/missing root node/)
  })

  test('rejects edge offsets not bounded by edgeCount', () => {
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeEdgeOffset[0] = 1 }),
      termCount,
    )).toThrow(/edge offsets not bounded/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeEdgeOffset[d.nodeCount] = d.edgeCount + 1 }),
      termCount,
    )).toThrow(/edge offsets not bounded/)
  })

  test('rejects non-monotonic edge offsets', () => {
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeEdgeOffset[1] = 99 }),
      termCount,
    )).toThrow(/edge offsets not monotonic/)
  })

  test('rejects node value without leaf', () => {
    const leafNode = Array.from(base.nodeLeafOrder).findIndex(order => order !== 0)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => {
        d.nodeLeafOrder[leafNode] = 0
        d.nodeValue[leafNode] = 7
      }),
      termCount,
    )).toThrow(/has value without leaf/)
  })

  test('rejects leaf order out of bounds', () => {
    const leafNode = Array.from(base.nodeLeafOrder).findIndex(order => order !== 0)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeLeafOrder[leafNode] = 99 }),
      termCount,
    )).toThrow(/leaf order out of bounds/)
  })

  test('rejects leaf index out of range', () => {
    const leafNode = Array.from(base.nodeLeafOrder).findIndex(order => order !== 0)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeValue[leafNode] = termCount }),
      termCount,
    )).toThrow(/leaf index out of range/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeValue[leafNode] = -1 }),
      termCount,
    )).toThrow(/leaf index out of range/)
  })

  test('rejects duplicate leaf index', () => {
    const leaves = Array.from(base.nodeLeafOrder)
      .map((order, node) => (order !== 0 ? node : -1))
      .filter(node => node >= 0)
    expect(leaves.length).toBeGreaterThanOrEqual(2)
    const [first, second] = leaves
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.nodeValue[second] = d.nodeValue[first] }),
      termCount,
    )).toThrow(/duplicate leaf index/)
  })

  test('rejects invalid edge labels', () => {
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.edgeLabelLength[0] = 0 }),
      termCount,
    )).toThrow(/label range out of bounds/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => {
        d.edgeLabelStart[0] = d.labelHeap.length
        d.edgeLabelLength[0] = 1
      }),
      termCount,
    )).toThrow(/label range out of bounds/)
  })

  test('rejects edge child out of bounds', () => {
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.edgeChild[0] = d.nodeCount }),
      termCount,
    )).toThrow(/child out of bounds/)
  })

  test('rejects leaf count and size mismatches', () => {
    const leafNode = Array.from(base.nodeLeafOrder).findIndex(order => order !== 0)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => {
        d.nodeLeafOrder[leafNode] = 0
        d.nodeValue[leafNode] = 0
      }),
      termCount,
    )).toThrow(/leaf count/)
    expect(() => validateFrozenTermIndexLeaves(
      cloneTree(base, (d) => { d.size = termCount + 1 }),
      termCount,
    )).toThrow(/size .* !== termCount/)
  })
})
