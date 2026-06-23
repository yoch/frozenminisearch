import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import PackedRadixTree from './PackedRadixTree'
import CRC32 from 'crc-32'
import { LEAF } from './SearchableMap/TreeIterator'
import {
  encodeFrozenSnapshot,
  decodeFrozenSnapshot,
  deserializeTermIndexTree,
  validateFrozenSnapshot,
  crc32Buffer,
  BINARY_MAGIC_V5,
} from './binaryFormat'
import {
  CODEC_RAW,
  CODEC_ZLIB,
  FLAG_SPARSE_LAYOUT,
  MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_OFFSET,
  MSV5_SECTION_DIR_OFFSET,
  Msv5SectionId,
} from './msv5/binaryMsv5Constants'
import { loadMsv5Sections, readMsv5SectionDirectory } from './msv5/binaryMsv5Compression'
function densePostings(fieldCount, termCount, nextId, offsets, lengths, docIds, freqs) {
  return {
    fieldCount,
    termCount,
    nextId,
    layout: 'dense',
    docIdWidth: 32,
    sparseFieldIdWidth: null,
    allDocIds: docIds,
    allFreqs: freqs,
    denseOffsets: offsets,
    denseLengths: lengths,
    sparseTermStarts: null,
    sparseFieldIds: null,
    sparseOffsets: null,
    sparseLengths: null,
  }
}

const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' },
]

const options = { fields: ['title', 'text'] }

function buildSnapshotFromFrozen() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = FrozenMiniSearch.fromMiniSearch(mutable, {})
  const buf = frozen.saveBinarySync()
  return decodeFrozenSnapshot(buf)
}

function msv5SectionDirOffset(sectionId) {
  return MSV5_SECTION_DIR_OFFSET + sectionId * 20
}

describe('binaryFormat MSv5', () => {
  test('round-trip preserves flat postings', () => {
    const treeShape = [
      ['hello', [[LEAF, 0]]],
      ['world', [[LEAF, 1]]],
    ]
    const snap = {
      documentCount: 2,
      nextId: 2,
      fieldIds: { txt: 0 },
      fieldCount: 1,
      fieldNames: ['txt'],
      avgFieldLength: new Float32Array([2]),
      externalIds: [1, 2],
      storedFields: [undefined, undefined],
      fieldLengthMatrix: new Uint32Array([1, 2]),
      treeShape,
      postings: densePostings(
        1, 2, 2,
        new Uint32Array([0, 1]),
        new Uint32Array([1, 1]),
        new Uint32Array([0, 1]),
        new Uint8Array([1, 1]),
      ),
    }

    const buf = encodeFrozenSnapshot(snap, deserializeTermIndexTree(treeShape))
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V5)
    expect(buf.readUInt16LE(4)).toBe(5)

    const loaded = decodeFrozenSnapshot(buf)
    expect(loaded.documentCount).toBe(2)
    expect(loaded.fieldNames).toEqual(['txt'])
    expect(Array.from(loaded.packedTermIndex.entries()).map(([t]) => t).sort())
      .toEqual(['hello', 'world'])
    expect(Array.from(loaded.postings.allDocIds)).toEqual([0, 1])
    expect(Array.from(loaded.postings.allFreqs)).toEqual([1, 1])
    expect(Array.from(loaded.postings.denseLengths)).toEqual([1, 1])
  })

  test('encodeFrozenSnapshot accepts explicit zlib compression', () => {
    const snap = buildSnapshotFromFrozen()
    const buf = encodeFrozenSnapshot(snap, undefined, undefined, 'zlib')
    expect(buf.readUInt8(8)).toBe(CODEC_ZLIB)
    expect(decodeFrozenSnapshot(buf).documentCount).toBe(snap.documentCount)
  })

  test('encode rejects invalid snapshot', () => {
    const snap = buildSnapshotFromFrozen()
    snap.postings.allFreqs = new Uint8Array(snap.postings.allDocIds.length - 1)
    expect(() => encodeFrozenSnapshot(snap)).toThrow(/Invalid frozen index/)
  })

  test('validateFrozenSnapshot rejects bad packed term leaf index', () => {
    const snap = buildSnapshotFromFrozen()
    const tree = snap.packedTermIndex
    const nodeValue = new Uint32Array(tree.nodeValue)
    const leafNode = Array.from(tree.nodeLeafOrder).findIndex(order => order !== 0)
    nodeValue[leafNode] = 999
    const bad = PackedRadixTree.fromData({
      size: tree.size,
      nodeCount: tree.nodeCount,
      edgeCount: tree.edgeCount,
      labelHeap: tree.labelHeap,
      nodeEdgeOffset: tree.nodeEdgeOffset,
      nodeValue,
      nodeLeafOrder: tree.nodeLeafOrder,
      edgeLabelStart: tree.edgeLabelStart,
      edgeLabelLength: tree.edgeLabelLength,
      edgeChild: tree.edgeChild,
    })
    snap.packedTermIndex = bad
    expect(() => validateFrozenSnapshot(snap)).toThrow(/leaf index out of range/)
  })

  test('rejects legacy MSv1 through MSv4', () => {
    const versions = { MSv1: 1, MSv2: 2, MSv3: 3, MSv4: 4 }
    for (const magic of Object.keys(versions)) {
      const buf = Buffer.alloc(64)
      buf.write(magic, 0, 4, 'ascii')
      buf.writeUInt16LE(versions[magic], 4)
      expect(() => decodeFrozenSnapshot(buf)).toThrow(/Unsupported frozen binary snapshot/)
    }
  })

  test('rejects unknown binary magic', () => {
    const buf = Buffer.alloc(64)
    buf.write('XXXX', 0, 4, 'ascii')
    expect(() => decodeFrozenSnapshot(buf)).toThrow(/Invalid frozen index/)
  })

  test('rejects section CRC mismatch', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = Buffer.from(FrozenMiniSearch.fromMiniSearch(mutable, {}).saveBinarySync())
    const coreDir = msv5SectionDirOffset(Msv5SectionId.Core)
    buf.writeUInt32LE(0, coreDir + 8)
    expect(() => decodeFrozenSnapshot(buf)).toThrow(/CRC mismatch/)
  })

  test('external id number and string round-trip', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.add({ id: 'alpha', text: 'one' })
    mutable.add({ id: 42, text: 'two' })
    const snap = decodeFrozenSnapshot(FrozenMiniSearch.fromMiniSearch(mutable, {}).saveBinarySync())
    expect(snap.externalIds[0]).toBe('alpha')
    expect(snap.externalIds[1]).toBe(42)
  })

  test('dense Uint32 postings round-trip via MSv5', () => {
    const snap = {
      documentCount: 70000,
      nextId: 70000,
      fieldIds: { txt: 0 },
      fieldCount: 1,
      fieldNames: ['txt'],
      avgFieldLength: new Float32Array([1]),
      externalIds: new Array(70000).fill(0).map((_, i) => i),
      storedFields: new Array(70000),
      fieldLengthMatrix: new Uint32Array(70000),
      treeShape: [['only', [[LEAF, 0]]]],
      postings: densePostings(
        1, 1, 70000,
        new Uint32Array([0]),
        new Uint32Array([1]),
        new Uint32Array([0]),
        new Uint8Array([1]),
      ),
    }
    const buf = encodeFrozenSnapshot(snap, deserializeTermIndexTree(snap.treeShape))
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V5)
    expect(buf.readUInt16LE(4)).toBe(5)
    expect(decodeFrozenSnapshot(buf).packedTermIndex.get('only')).toBe(0)
  })

  test('sparse layout with >255 fields uses Uint16 field ids', () => {
    const fieldCount = 300
    const fields = Array.from({ length: fieldCount }, (_, i) => `f${i}`)
    const docs = [{ id: 0 }]
    for (let f = 0; f < fieldCount; f++) {
      docs[0][fields[f]] = `value field ${f}`
    }
    const mutable = new MiniSearch({ fields, storeFields: [] })
    mutable.addAll(docs)
    const frozen = FrozenMiniSearch.fromMiniSearch(mutable, { fields })
    expect(frozen._memoryBreakdown().postings.layout).toBe('sparse')

    const buf = frozen.saveBinarySync()
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V5)
    expect(buf.readUInt16LE(6) & 4).toBe(4)

    const loaded = FrozenMiniSearch.loadBinarySync(buf, { fields })
    expect(loaded.search('value').length).toBeGreaterThan(0)
  })

  test('adaptive dense multi-field layout round-trips via MSv5', () => {
    const fields = ['f0', 'f1', 'f2', 'f3']
    const docs = Array.from({ length: 4 }, (_, id) => ({
      id,
      f0: `term${id} common`,
      f1: `term${id} common`,
      f2: `term${id} common`,
      f3: `term${id} common`,
    }))
    const options = { fields, storeFields: [] }
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    expect(frozen._memoryBreakdown().postings.layout).toBe('dense')

    const buf = frozen.saveBinarySync()
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V5)
    expect(buf.readUInt16LE(6) & FLAG_SPARSE_LAYOUT).toBe(0)

    const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
    expect(loaded._memoryBreakdown().postings.layout).toBe('dense')
    expect(loaded.search('term2')).toEqual(frozen.search('term2'))
  })

  test('external id JSON blob round-trip', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.add({ id: { k: 'complex' }, text: 'data' })
    const snap = decodeFrozenSnapshot(FrozenMiniSearch.fromMiniSearch(mutable, {}).saveBinarySync())
    expect(snap.externalIds[0]).toEqual({ k: 'complex' })
  })
})

describe('binaryFormat corruption guards', () => {
  let validBuf

  beforeEach(() => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    validBuf = FrozenMiniSearch.fromMiniSearch(mutable, {}).saveBinarySync()
  })

  test('rejects buffer shorter than header', () => {
    expect(() => decodeFrozenSnapshot(validBuf.subarray(0, 20))).toThrow(/buffer too short/)
  })

  test('rejects non-monotonic section offsets', () => {
    const corrupt = Buffer.from(validBuf)
    const flDir = msv5SectionDirOffset(Msv5SectionId.FieldLengthMatrix)
    const postDir = msv5SectionDirOffset(Msv5SectionId.PostMeta)
    const flOff = corrupt.readUInt32LE(flDir)
    const postOff = corrupt.readUInt32LE(postDir)
    corrupt.writeUInt32LE(postOff, flDir)
    corrupt.writeUInt32LE(flOff, postDir)
    expect(() => decodeFrozenSnapshot(corrupt)).toThrow(/not monotonic/)
  })

  test('rejects section payload past buffer end', () => {
    const corrupt = Buffer.from(validBuf)
    corrupt.writeUInt32LE(validBuf.length + 100, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
    expect(() => decodeFrozenSnapshot(corrupt)).toThrow(/out of bounds/)
  })

  test('rejects allFreqs shorter than allDocIds', () => {
    const corrupt = Buffer.from(validBuf)
    const freqsDir = msv5SectionDirOffset(Msv5SectionId.AllFreqs)
    const uncomp = corrupt.readUInt32LE(freqsDir + 8)
    corrupt.writeUInt32LE(uncomp - 1, freqsDir + 8)
    expect(() => decodeFrozenSnapshot(corrupt)).toThrow(/CRC mismatch|length mismatch/)
  })

  test('rejects posting offset beyond allDocIds', () => {
    const snap = decodeFrozenSnapshot(validBuf)
    if (snap.postings.layout === 'sparse') {
      const lengths = snap.postings.sparseLengths
      const offsets = snap.postings.sparseOffsets
      for (let i = 0; i < lengths.length; i++) {
        if (lengths[i] > 0) {
          offsets[i] = snap.postings.allDocIds.length
          expect(() => encodeFrozenSnapshot(snap)).toThrow(/exceeds allDocIds/)
          return
        }
      }
    } else {
      const lengths = snap.postings.denseLengths
      const offsets = snap.postings.denseOffsets
      for (let i = 0; i < lengths.length; i++) {
        if (lengths[i] > 0) {
          offsets[i] = snap.postings.allDocIds.length
          expect(() => encodeFrozenSnapshot(snap)).toThrow(/exceeds allDocIds/)
          return
        }
      }
    }
    throw new Error('fixture has no non-empty posting')
  })

  test('rejects fieldLengthMatrix size mismatch', () => {
    const snap = decodeFrozenSnapshot(validBuf)
    snap.fieldLengthMatrix = new Uint32Array(1)
    expect(() => validateFrozenSnapshot(snap)).toThrow(/fieldLengthMatrix/)
  })

  test('section CRC matches uncompressed payload', () => {
    const directory = readMsv5SectionDirectory(validBuf)
    const coreEntry = directory[Msv5SectionId.Core]
    const coreSection = loadMsv5Sections(validBuf, directory)[Msv5SectionId.Core]
    expect(coreEntry.sectionCrc32).toBe(crc32Buffer(coreSection))
  })

  test('rejects core termCount mismatch with postings', () => {
    const corrupt = Buffer.from(validBuf)
    if (corrupt.readUInt8(8) !== CODEC_RAW) {
      return
    }
    const payloadOff = corrupt.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_OFFSET)
    const coreBase = payloadOff + corrupt.readUInt32LE(msv5SectionDirOffset(Msv5SectionId.Core))
    corrupt.writeUInt32LE(999999, coreBase + 12)
    expect(() => decodeFrozenSnapshot(corrupt)).toThrow(/leaf index out of range|termCount|CRC mismatch/)
  })
})

describe('FrozenMiniSearch loadBinary fields', () => {
  test('load without fields uses snapshot field names', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = FrozenMiniSearch.fromMiniSearch(mutable, options)
    const buf = frozen.saveBinarySync()
    const loaded = FrozenMiniSearch.loadBinarySync(buf, {})
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })
})

describe('crc32Buffer verification', () => {
  test('matches crc-32 npm library on various inputs', () => {
    const inputs = [
      '',
      'hello',
      'world',
      'minisearch',
      'A'.repeat(100),
      'A'.repeat(1024),
      '🚀 emoji test 💖',
      'accentués éàïô',
    ]

    for (const str of inputs) {
      const buf = Buffer.from(str, 'utf8')
      const ourCrc = crc32Buffer(buf)
      const expectedCrc = CRC32.buf(buf) >>> 0
      expect(ourCrc).toBe(expectedCrc)
    }
  })

  test('matches crc-32 npm library with start and end offsets', () => {
    const buf = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789', 'utf8')
    const sub = buf.subarray(5, 20)

    // Test our start/end arguments against native buffer subarray
    const ourCrcWithOffsets = crc32Buffer(buf, 5, 20)
    const expectedCrcOfSubarray = CRC32.buf(sub) >>> 0
    expect(ourCrcWithOffsets).toBe(expectedCrcOfSubarray)
  })

  test('matches crc-32 npm library on random binary buffers', () => {
    // Generate random binary buffer
    const buf = Buffer.alloc(4096)
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 256)
    }

    const ourCrc = crc32Buffer(buf)
    const expectedCrc = CRC32.buf(buf) >>> 0
    expect(ourCrc).toBe(expectedCrc)

    // Test with partial bounds
    const start = 128
    const end = 2048
    const ourCrcPartial = crc32Buffer(buf, start, end)
    const expectedCrcPartial = CRC32.buf(buf.subarray(start, end)) >>> 0
    expect(ourCrcPartial).toBe(expectedCrcPartial)
  })
})
