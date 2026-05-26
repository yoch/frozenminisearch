import MiniSearch from './MiniSearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { LEAF } from './SearchableMap/TreeIterator'
import {
  encodeFrozenSnapshot,
  encodeMSv1Snapshot,
  decodeFrozenSnapshot,
  validateFrozenSnapshot,
  BINARY_MAGIC_V2
} from './binaryFormat'

const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' }
]

const options = { fields: ['title', 'text'] }

function buildSnapshotFromFrozen () {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = mutable.freeze()
  const buf = frozen.saveBinary()
  return decodeFrozenSnapshot(buf)
}

describe('binaryFormat MSv2', () => {
  test('round-trip preserves flat postings', () => {
    const snap = {
      documentCount: 2,
      nextId: 2,
      fieldIds: { txt: 0 },
      fieldCount: 1,
      avgFieldLength: new Float32Array([2]),
      externalIds: [1, 2],
      storedFields: [undefined, undefined],
      fieldLengthMatrix: new Uint32Array([1, 2]),
      terms: ['hello', 'world'],
      treeShape: [
        ['hello', [[LEAF, 0]]],
        ['world', [[LEAF, 1]]]
      ],
      postingsOffsets: new Uint32Array([0, 1]),
      postingsLengths: new Uint32Array([1, 1]),
      allDocIds: new Uint32Array([0, 1]),
      allFreqs: new Uint8Array([1, 1])
    }

    const buf = encodeFrozenSnapshot(snap)
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V2)

    const loaded = decodeFrozenSnapshot(buf)
    expect(loaded.documentCount).toBe(2)
    expect(loaded.terms).toEqual(['hello', 'world'])
    expect(Array.from(loaded.allDocIds)).toEqual([0, 1])
    expect(Array.from(loaded.allFreqs)).toEqual([1, 1])
    expect(Array.from(loaded.postingsLengths)).toEqual([1, 1])
  })

  test('encode rejects invalid snapshot', () => {
    const snap = buildSnapshotFromFrozen()
    snap.allFreqs = new Uint8Array(snap.allDocIds.length - 1)
    expect(() => encodeFrozenSnapshot(snap)).toThrow(/Invalid frozen index/)
  })

  test('validateFrozenSnapshot rejects bad treeShape index', () => {
    const snap = buildSnapshotFromFrozen()
    snap.treeShape = [['bad', [[LEAF, 999]]]]
    expect(() => validateFrozenSnapshot(snap)).toThrow(/treeShape leaf/)
  })
})

describe('binaryFormat MSv1', () => {
  test('rejects unknown binary magic', () => {
    const buf = Buffer.alloc(32)
    buf.write('XXXX', 0, 4, 'ascii')
    expect(() => decodeFrozenSnapshot(buf)).toThrow(/Invalid frozen index/)
  })

  test('MSv1 round-trip search parity', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    const snap = decodeFrozenSnapshot(frozen.saveBinary())
    const msv1 = encodeMSv1Snapshot(snap)
    const loaded = FrozenMiniSearch.loadBinary(msv1, options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
    expect(loaded.search('hel', { prefix: true })).toEqual(frozen.search('hel', { prefix: true }))
  })
})

describe('binaryFormat corruption guards', () => {
  let validBuf

  beforeEach(() => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    validBuf = mutable.freeze().saveBinary()
  })

  test('rejects buffer shorter than header', () => {
    expect(() => decodeFrozenSnapshot(validBuf.subarray(0, 20))).toThrow(/buffer too short/)
  })

  test('rejects non-monotonic section offsets', () => {
    const corrupt = Buffer.from(validBuf)
    corrupt.writeUInt32LE(corrupt.readUInt32LE(20) + 1, 12)
    expect(() => decodeFrozenSnapshot(corrupt)).toThrow(/not monotonic/)
  })

  test('rejects end offset past buffer end', () => {
    const corrupt = Buffer.from(validBuf)
    corrupt.writeUInt32LE(validBuf.length + 100, 40)
    expect(() => decodeFrozenSnapshot(corrupt)).toThrow(/Invalid frozen index/)
  })

  test('rejects allFreqs shorter than allDocIds', () => {
    const corrupt = Buffer.from(validBuf)
    const freqsOff = corrupt.readUInt32LE(36)
    const endOff = corrupt.readUInt32LE(40)
    corrupt.writeUInt32LE(endOff - 1, 40)
    corrupt.writeUInt8(0, freqsOff + (endOff - freqsOff) - 1)
    expect(() => decodeFrozenSnapshot(corrupt)).toThrow(/length mismatch/)
  })

  test('rejects posting offset beyond allDocIds', () => {
    const snap = decodeFrozenSnapshot(validBuf)
    for (let i = 0; i < snap.postingsLengths.length; i++) {
      if (snap.postingsLengths[i] > 0) {
        snap.postingsOffsets[i] = snap.allDocIds.length
        expect(() => encodeFrozenSnapshot(snap)).toThrow(/exceeds allDocIds/)
        return
      }
    }
    throw new Error('fixture has no non-empty posting')
  })

  test('rejects fieldLengthMatrix size mismatch', () => {
    const snap = decodeFrozenSnapshot(validBuf)
    snap.fieldLengthMatrix = new Uint32Array(1)
    expect(() => validateFrozenSnapshot(snap)).toThrow(/fieldLengthMatrix/)
  })
})
