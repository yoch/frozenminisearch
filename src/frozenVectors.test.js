import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import FrozenMiniSearchBrowser, {
  FrozenVectorIndex as BrowserFrozenVectorIndex,
} from './browser'
import { FrozenVectorIndex } from './frozenVectors'
import { crc32Buffer } from './binaryIo'
import { writeU32LE } from './binaryBytes'
import { frozenMemoryBreakdown } from '../testSupport/frozenMemoryBreakdown.js'

function makeUnitVec(dim, seedIdx) {
  const v = new Float32Array(dim)
  let norm2 = 0
  for (let d = 0; d < dim; d++) {
    const val = Math.sin((seedIdx + 1) * (d + 1) * 0.73) + Math.cos(d - seedIdx)
    v[d] = val
    norm2 += val * val
  }
  const inv = 1 / Math.sqrt(norm2)
  for (let d = 0; d < dim; d++) v[d] *= inv
  return v
}

function resealVectorBinary(bytes) {
  const copy = new Uint8Array(bytes)
  const payloadCrc = crc32Buffer(copy, 40, copy.length) >>> 0
  writeU32LE(copy, 32, payloadCrc)
  const headerCrc = crc32Buffer(copy, 0, 36) >>> 0
  writeU32LE(copy, 36, headerCrc)
  return copy
}

describe('FrozenVectorIndex numerical contracts (B2)', () => {
  test('dim=16 q=[127..127] vs d=[127,0..0] yields exact cosine 0.25 (not 1)', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [
        { id: 'target', text: 'doc zero' },
        { id: 'diag', text: 'doc diag' },
      ],
      { fields: ['text'] },
    )
    const q = new Float32Array(16).fill(127)
    const d0 = new Float32Array(16)
    d0[0] = 127
    const d1 = new Float32Array(16).fill(127)

    for (const quantization of ['float32', 'int8', 'pq']) {
      for (const normalize of [false, true]) {
        const vi = FrozenVectorIndex.fromDocumentVectors(
          index,
          [
            { id: 'target', vector: d0 },
            { id: 'diag', vector: d1 },
          ],
          {
            dim: 16,
            quantization,
            normalize,
            metric: 'cosine',
            pqSubspaces: 4,
          },
        )

        const rawTargetScore = vi.scoreDocument(q, 'target')
        expect(rawTargetScore).toBeCloseTo(0.25, 5)
        expect(vi.scoreDocument(q, 'diag')).toBeCloseTo(1, 5)

        const hits = vi.topK(q, { k: 2 })
        expect(hits.map((h) => h.id)).toEqual(['diag', 'target'])
        expect(hits[1].score).toBeCloseTo(0.25, 5)

        const reloaded = FrozenVectorIndex.loadBinary(vi.saveBinary(), index)
        expect(reloaded.scoreDocument(q, 'target')).toBeCloseTo(0.25, 5)
      }
    }
  })

  test('int8 reconstructed norm prevents cosine > 1 on unit vectors', () => {
    const docs = Array.from({ length: 12 }, (_, i) => ({
      id: `doc-${i}`,
      text: `item ${i}`,
    }))
    const index = FrozenMiniSearch.fromDocuments(docs, { fields: ['text'] })
    const entries = docs.map((d, i) => [d.id, makeUnitVec(16, i)])
    const f32 = FrozenVectorIndex.fromDocumentVectors(index, entries, {
      dim: 16,
      quantization: 'float32',
      normalize: true,
    })
    const i8 = FrozenVectorIndex.fromDocumentVectors(index, entries, {
      dim: 16,
      quantization: 'int8',
      normalize: true,
    })
    expect(i8.hasReconstructedNorms).toBe(true)

    for (let i = 0; i < docs.length; i++) {
      const q = entries[i][1]
      const selfCos = i8.scoreDocument(q, docs[i].id)
      expect(selfCos).toBeLessThanOrEqual(1 + 1e-6)
      expect(selfCos).toBeGreaterThan(0.998)
      expect(Math.abs(selfCos - f32.scoreDocument(q, docs[i].id))).toBeLessThan(
        0.003,
      )
    }
  })

  test('dot vs cosine contracts, zero vectors, negative scores, ties and k=0', () => {
    const docs = [
      { id: 0, text: 'a' },
      { id: 1, text: 'b' },
      { id: 2, text: 'c' },
      { id: 3, text: 'd' },
    ]
    const index = FrozenMiniSearch.fromDocuments(docs, { fields: ['text'] })
    const matrix = new Float32Array([
      2,
      0,
      0,
      0, // doc 0: +x scaled 2
      2,
      0,
      0,
      0, // doc 1: tie with doc 0
      -3,
      0,
      0,
      0, // doc 2: opposite direction
      0,
      0,
      0,
      0, // doc 3: zero vector
    ])

    const dotIdx = FrozenVectorIndex.fromDenseFloat32(index, matrix, {
      dim: 4,
      quantization: 'float32',
      metric: 'dot',
    })
    expect(dotIdx.topK([1, 0, 0, 0], { k: 0 })).toEqual([])
    expect(dotIdx.topK([1, 0, 0, 0], { k: 10 })).toEqual([
      { id: 0, shortId: 0, score: 2 },
      { id: 1, shortId: 1, score: 2 },
      { id: 3, shortId: 3, score: 0 },
      { id: 2, shortId: 2, score: -3 },
    ])
    expect(() => dotIdx.topK([1, 0, 0, 0], { metric: 'cosine' })).toThrow(
      /dot-only/,
    )

    const cosIdx = FrozenVectorIndex.fromDenseFloat32(index, matrix, {
      dim: 4,
      quantization: 'int8',
      metric: 'cosine',
    })
    expect(cosIdx.topK([0, 0, 0, 0], { minScore: 0.1 })).toEqual([])
    const zeroHits = cosIdx.topK([0, 0, 0, 0], { k: 4 })
    expect(zeroHits.every((h) => h.score === 0)).toBe(true)
    const opp = cosIdx.topK([5, 0, 0, 0], { k: 4 })
    expect(opp.map((h) => h.id)).toEqual([0, 1, 3, 2])
    expect(opp[3].score).toBeCloseTo(-1, 5)
  })
})

describe('FrozenVectorIndex pre-k filter, re-entrancy & immutability (B3)', () => {
  test('pre-k filter finds admissible docs past top-85 excluded candidates', () => {
    const N = 120
    const docs = Array.from({ length: N }, (_, i) => ({
      id: `item-${i}`,
      text: `token ${i}`,
    }))
    const index = FrozenMiniSearch.fromDocuments(docs, { fields: ['text'] })
    const mat = new Float32Array(N * 8)
    for (let i = 0; i < N; i++) {
      // Lower i has strictly higher cosine with [1, 0, ...]
      mat[i * 8] = 1 - i * 0.005
      mat[i * 8 + 1] = Math.sqrt(Math.max(0, 1 - mat[i * 8] ** 2))
    }

    for (const quantization of ['float32', 'int8', 'pq']) {
      const vi = FrozenVectorIndex.fromDenseFloat32(index, mat, {
        dim: 8,
        quantization,
        metric: 'cosine',
        pqSubspaces: 4,
      })
      const hits = vi.topK([1, 0, 0, 0, 0, 0, 0, 0], {
        k: 5,
        filter: (_id, shortId) => shortId >= 90,
      })
      expect(hits).toHaveLength(5)
      expect(hits.every((h) => h.shortId >= 90)).toBe(true)
      expect(hits[0].shortId).toBe(90)
    }
  })

  test('supports nested/re-entrant searches and isolates caller buffers', () => {
    const docs = [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
      { id: 'c', text: 'gamma' },
    ]
    const index = FrozenMiniSearch.fromDocuments(docs, { fields: ['text'] })
    const beforeMem = frozenMemoryBreakdown(index)
    const rawVecs = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    const vi = FrozenVectorIndex.fromDenseFloat32(index, rawVecs, {
      dim: 4,
      quantization: 'float32',
      normalize: true,
    })
    rawVecs.fill(0) // Mutate caller's input buffer
    expect(vi.topK([1, 0, 0, 0], { k: 1 }).map((h) => h.id)).toEqual(['a'])

    // Lexical index & memory remain completely untouched (even lazy id-map stays unallocated by topK)
    expect(frozenMemoryBreakdown(index)).toEqual(beforeMem)
    expect(index.search('alpha').map((h) => h.id)).toEqual(['a'])
    expect(vi.scoreDocument([1, 0, 0, 0], 'a')).toBeCloseTo(1, 5)

    // Nested topK inside filter callback
    const nested = vi.topK([1, 0.5, 0, 0], {
      k: 2,
      filter: () => {
        const inner = vi.topK([0, 0, 1, 0], { k: 1 })
        return inner[0].id === 'c'
      },
    })
    expect(nested.map((h) => h.id)).toEqual(['a', 'b'])

    // Binary buffer mutation after loadBinary must not corrupt loaded index
    const packed = vi.saveBinary()
    const loaded = FrozenVectorIndex.loadBinary(packed, index)
    packed.fill(0xff)
    expect(loaded.scoreDocument([0, 1, 0, 0], 'b')).toBeCloseTo(1, 5)
  })
})

describe('FrozenVectorIndex corpus binding, Node<->Browser & adversarial hardening', () => {
  test('Node <-> Browser binary round-trip on float32, int8 and pq + unaligned slice', async () => {
    const docs = Array.from({ length: 24 }, (_, i) => ({
      id: `cis_${6000 + i}`,
      text: `medicament ${i}`,
    }))
    const nodeIdx = FrozenMiniSearch.fromDocuments(docs, { fields: ['text'] })
    const snap = nodeIdx.saveBinarySync({ compression: 'zlib' })
    const browserIdx = await FrozenMiniSearchBrowser.loadBinaryAsync(snap, {
      fields: ['text'],
    })

    const mat = new Float32Array(docs.length * 16)
    for (let i = 0; i < docs.length; i++) {
      mat.set(makeUnitVec(16, i), i * 16)
    }

    for (const quantization of ['float32', 'int8', 'pq']) {
      const nodeVec = FrozenVectorIndex.fromDenseFloat32(nodeIdx, mat, {
        dim: 16,
        quantization,
        metric: 'cosine',
        pqSubspaces: 4,
      })
      const bin = nodeVec.saveBinary()
      const unaligned = new Uint8Array(bin.length + 3)
      unaligned.set(bin, 3)

      const browserVec = BrowserFrozenVectorIndex.loadBinary(
        unaligned.subarray(3),
        browserIdx,
      )
      expect(browserVec.stats()).toEqual(nodeVec.stats())
      const q = makeUnitVec(16, 7)
      expect(browserVec.topK(q, { k: 5 })).toEqual(nodeVec.topK(q, { k: 5 }))

      const rtNode = FrozenVectorIndex.loadBinary(
        browserVec.saveBinary(),
        nodeIdx,
      )
      expect(rtNode.topK(q, { k: 5 })).toEqual(nodeVec.topK(q, { k: 5 }))
    }
  })

  test('handles corpus holes, -0 vs +0 ids, empty corpus and partial coverage', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll([
      { id: 'keep0', text: 'alpha' },
      { id: 'drop1', text: 'beta' },
      { id: 'keep2', text: 'gamma' },
    ])
    mutable.discard('drop1')
    const holeIndex = FrozenMiniSearch.fromJSON(
      JSON.stringify(mutable.toJSON()),
      { fields: ['text'] },
    )
    expect(holeIndex.documentCount).toBe(2)

    const vi = FrozenVectorIndex.fromDocumentVectors(
      holeIndex,
      [
        ['keep0', [1, 0, 0, 0]],
        ['keep2', [0, 1, 0, 0]],
      ],
      { dim: 4, quantization: 'int8' },
    )
    expect(vi.presentCount).toBe(2)
    expect(vi.hasVector('drop1')).toBe(false)
    expect(vi.hasVector('keep2')).toBe(true)
    const loaded = FrozenVectorIndex.loadBinary(vi.saveBinary(), holeIndex)
    expect(loaded.topK([0, 1, 0, 0], { k: 5 }).map((h) => h.id)).toEqual([
      'keep2',
      'keep0',
    ])

    // Empty corpus
    const emptyIdx = FrozenMiniSearch.fromDocuments([], { fields: ['text'] })
    for (const quantization of ['float32', 'int8', 'pq']) {
      const emptyVec = FrozenVectorIndex.fromDenseFloat32(
        emptyIdx,
        new Float32Array(0),
        { dim: 4, quantization },
      )
      expect(emptyVec.topK([1, 0, 0, 0])).toEqual([])
      expect(
        FrozenVectorIndex.loadBinary(emptyVec.saveBinary(), emptyIdx).stats()
          .documentCount,
      ).toBe(0)
    }

    // -0 vs +0 external IDs produce distinct corpus fingerprints
    const idxPosZero = FrozenMiniSearch.fromDocuments(
      [
        { id: 0, text: 'a' },
        { id: 1, text: 'b' },
      ],
      { fields: ['text'] },
    )
    const idxNegZero = FrozenMiniSearch.fromDocuments(
      [
        { id: -0, text: 'a' },
        { id: 1, text: 'b' },
      ],
      { fields: ['text'] },
    )
    const posPack = FrozenVectorIndex.fromDenseFloat32(
      idxPosZero,
      new Float32Array([1, 0, 0, 1]),
      { dim: 2 },
    ).saveBinary()
    expect(() => FrozenVectorIndex.loadBinary(posPack, idxNegZero)).toThrow(
      /fingerprint mismatch/,
    )
  })

  test('rejects swapped doc order, forged headers, CRCs, truncation and NaN payloads', () => {
    const idxA = FrozenMiniSearch.fromDocuments(
      [
        { id: 'doc1', text: 'one' },
        { id: 'doc2', text: 'two' },
      ],
      { fields: ['text'] },
    )
    const idxSwapped = FrozenMiniSearch.fromDocuments(
      [
        { id: 'doc2', text: 'two' },
        { id: 'doc1', text: 'one' },
      ],
      { fields: ['text'] },
    )
    const f32Vec = FrozenVectorIndex.fromDenseFloat32(
      idxA,
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
      { dim: 4, quantization: 'float32', metric: 'dot' },
    )
    const pack = f32Vec.saveBinary()

    // Same documentCount (2), swapped order => rejected!
    expect(() => FrozenVectorIndex.loadBinary(pack, idxSwapped)).toThrow(
      /fingerprint mismatch/,
    )
    expect(() => f32Vec.assertCompatibleWith(idxSwapped)).toThrow(
      /fingerprint mismatch/,
    )

    // Short / invalid magic / wrong version / header CRC / payload CRC / trailing byte
    expect(() =>
      FrozenVectorIndex.loadBinary(pack.subarray(0, 10), idxA),
    ).toThrow(/too short/)
    const badMagic = new Uint8Array(pack)
    badMagic[0] = 0x58
    expect(() => FrozenVectorIndex.loadBinary(badMagic, idxA)).toThrow(/magic/)

    const badVer = new Uint8Array(pack)
    badVer[4] = 99
    expect(() =>
      FrozenVectorIndex.loadBinary(resealVectorBinary(badVer), idxA),
    ).toThrow(/version/)

    const badHdrCrc = new Uint8Array(pack)
    badHdrCrc[8] ^= 1
    expect(() => FrozenVectorIndex.loadBinary(badHdrCrc, idxA)).toThrow(
      /header CRC-32/,
    )

    const badPayCrc = new Uint8Array(pack)
    badPayCrc[badPayCrc.length - 1] ^= 1
    expect(() => FrozenVectorIndex.loadBinary(badPayCrc, idxA)).toThrow(
      /payload CRC-32/,
    )

    const trailing = new Uint8Array(pack.length + 1)
    trailing.set(pack)
    expect(() => FrozenVectorIndex.loadBinary(trailing, idxA)).toThrow(
      /byte length mismatch/,
    )

    // Forged NaN into Float32 with recomputed CRCs
    const forgedNan = new Uint8Array(pack)
    const dv = new DataView(forgedNan.buffer)
    dv.setFloat32(40, Number.NaN, true)
    expect(() =>
      FrozenVectorIndex.loadBinary(resealVectorBinary(forgedNan), idxA),
    ).toThrow(/non-finite/)

    // Forged negative scale into Int8 with recomputed CRCs
    const i8Pack = FrozenVectorIndex.fromDenseFloat32(
      idxA,
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
      { dim: 4, quantization: 'int8', metric: 'cosine' },
    ).saveBinary()
    const forgedNegNorm = new Uint8Array(i8Pack)
    new DataView(forgedNegNorm.buffer).setFloat32(40, -1, true)
    expect(() =>
      FrozenVectorIndex.loadBinary(resealVectorBinary(forgedNegNorm), idxA),
    ).toThrow(/negative row norm/)

    // Input errors
    expect(() =>
      FrozenVectorIndex.fromDenseFloat32(
        idxA,
        new Float32Array([1, Number.NaN, 0, 0, 0, 0, 0, 0]),
        { dim: 4 },
      ),
    ).toThrow(/non-finite/)
    expect(() =>
      FrozenVectorIndex.fromDocumentVectors(idxA, [['doc1', [1, 0, 0, 0]]], {
        dim: 4,
      }),
    ).toThrow(/expected 2 live/)
    expect(() =>
      FrozenVectorIndex.fromDocumentVectors(idxA, [['missing', [1, 0, 0, 0]]], {
        dim: 4,
        requireAllLiveDocs: false,
      }),
    ).toThrow(/unknown document id/)
  })
})
