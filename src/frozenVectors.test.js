import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import FrozenMiniSearchBrowser from './browser'
import * as mainEntry from './index'
import * as browserEntry from './browser'
import { FrozenVectorIndex } from './vectors'
import {
  encodeDenseVectorPack,
  encodeDocumentVectorPack,
  selectPqSampleIndices,
} from './vectorsTrain'
import { crc32Buffer } from './binaryIo'
import { writeFloatLE, writeU32LE } from './binaryBytes'
import { frozenMemoryBreakdown } from '../testSupport/frozenMemoryBreakdown.js'

const BASE_META = {
  representationVersion: 'test-vec:v1',
  snapshotId: 'test-snap:v1',
}

function withMeta(opts, extra = {}) {
  return { ...BASE_META, ...opts, ...extra }
}

function buildAnyDocumentVectors(host, entries, opts) {
  const full = withMeta(opts)
  if (full.quantization === 'pq') {
    const bytes = encodeDocumentVectorPack(host, entries, full)
    return FrozenVectorIndex.loadBinary(bytes, host, full)
  }
  return FrozenVectorIndex.fromDocumentVectors(host, entries, full)
}

function buildAnyDenseVectors(host, vectors, opts) {
  const full = withMeta(opts)
  if (full.quantization === 'pq') {
    const bytes = encodeDenseVectorPack(host, vectors, full)
    return FrozenVectorIndex.loadBinary(bytes, host, full)
  }
  return FrozenVectorIndex.fromDenseFloat32(host, vectors, full)
}

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
  test('lexical entrypoints do not re-export FrozenVectorIndex', () => {
    expect(mainEntry.FrozenVectorIndex).toBeUndefined()
    expect(browserEntry.FrozenVectorIndex).toBeUndefined()
  })

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
        const vi = buildAnyDocumentVectors(
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

        const reloaded = FrozenVectorIndex.loadBinary(
          vi.saveBinary(),
          index,
          BASE_META,
        )
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
    const f32 = buildAnyDocumentVectors(index, entries, {
      dim: 16,
      quantization: 'float32',
      normalize: true,
    })
    const i8 = buildAnyDocumentVectors(index, entries, {
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
      2, 0, 0, 0, 2, 0, 0, 0, -3, 0, 0, 0, 0, 0, 0, 0,
    ])

    const dotIdx = buildAnyDenseVectors(index, matrix, {
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

    const cosIdx = buildAnyDenseVectors(index, matrix, {
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

describe('FrozenVectorIndex pre-k filter, overflow safety & pqSampleSize (B3 + P2)', () => {
  test('pre-k filter finds admissible docs past top-85 excluded candidates', () => {
    const N = 120
    const docs = Array.from({ length: N }, (_, i) => ({
      id: `item-${i}`,
      text: `token ${i}`,
    }))
    const index = FrozenMiniSearch.fromDocuments(docs, { fields: ['text'] })
    const mat = new Float32Array(N * 8)
    for (let i = 0; i < N; i++) {
      mat[i * 8] = 1 - i * 0.005
      mat[i * 8 + 1] = Math.sqrt(Math.max(0, 1 - mat[i * 8] ** 2))
    }

    for (const quantization of ['float32', 'int8', 'pq']) {
      const vi = buildAnyDenseVectors(index, mat, {
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

  test('overflow/underflow-safe normalization on [1e40,1e40] and [1e300,1e300]', () => {
    const docs = [
      { id: 'diag', text: 'diagonal' },
      { id: 'ortho', text: 'orthogonal' },
    ]
    const index = FrozenMiniSearch.fromDocuments(docs, { fields: ['text'] })

    for (const quantization of ['float32', 'int8', 'pq']) {
      const vi = buildAnyDocumentVectors(
        index,
        [
          ['diag', [1e300, 1e300, 0, 0]],
          ['ortho', [0, 0, 1e40, 0]],
        ],
        {
          dim: 4,
          quantization,
          metric: 'cosine',
          normalize: true,
          pqSubspaces: 2,
        },
      )

      const qHuge40 = vi.topK([1e40, 1e40, 0, 0], { k: 2 })
      expect(Number.isFinite(qHuge40[0].score)).toBe(true)
      expect(qHuge40[0].id).toBe('diag')
      expect(qHuge40[0].score).toBeCloseTo(1, 2)

      const qHuge300 = vi.topK([1e300, 1e300, 0, 0], { k: 2 })
      expect(Number.isFinite(qHuge300[0].score)).toBe(true)
      expect(qHuge300[0].id).toBe('diag')
      expect(qHuge300[0].score).toBeCloseTo(1, 2)

      const qTiny = vi.topK([1e-300, 1e-300, 0, 0], { k: 2 })
      expect(Number.isFinite(qTiny[0].score)).toBe(true)
      expect(qTiny[0].id).toBe('diag')
      expect(qTiny[0].score).toBeCloseTo(1, 2)
    }

    // Unnormalized overflow must throw rather than silently storing Infinity/NaN
    expect(() =>
      buildAnyDocumentVectors(
        index,
        [
          ['diag', [1e40, 1e40, 0, 0]],
          ['ortho', [0, 0, 1, 0]],
        ],
        { dim: 4, quantization: 'float32', normalize: false, metric: 'dot' },
      ),
    ).toThrow(/float32 overflow/)

    const dotIdx = buildAnyDocumentVectors(
      index,
      [
        ['diag', [1, 1, 0, 0]],
        ['ortho', [0, 0, 1, 0]],
      ],
      { dim: 4, quantization: 'float32', metric: 'dot' },
    )
    expect(() => dotIdx.topK([1e40, 1e40, 0, 0], { metric: 'dot' })).toThrow(
      /float32 overflow/,
    )
  })

  test('pqSampleSize=4096 strictly caps training sample count when presentCount=5000', () => {
    const live5000 = new Int32Array(5000)
    for (let i = 0; i < 5000; i++) live5000[i] = i
    const sampled4096 = selectPqSampleIndices(live5000, 4096)
    expect(sampled4096.length).toBe(4096)
    expect(new Set(sampled4096).size).toBe(4096)
    expect(sampled4096[0]).toBe(0)
    expect(sampled4096[4095]).toBeLessThan(5000)

    // Verify runtime PQ pack rejects direct runtime build without vectors/train
    const smallIdx = FrozenMiniSearch.fromDocuments(
      [{ id: 'a', text: 'alpha' }],
      { fields: ['text'] },
    )
    expect(() =>
      FrozenVectorIndex.fromDenseFloat32(
        smallIdx,
        new Float32Array([1, 0, 0, 0]),
        withMeta({ dim: 4, quantization: 'pq' }),
      ),
    ).toThrow(/vectors\/train/)

    // End-to-end 5000-doc PQ pack with pqSampleSize: 4096 builds cleanly
    const docs5k = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      text: `d${i}`,
    }))
    const idx5k = FrozenMiniSearch.fromDocuments(docs5k, { fields: ['text'] })
    const mat5k = new Float32Array(5000 * 8)
    for (let i = 0; i < 5000; i++) {
      mat5k[i * 8 + (i % 8)] = 1
    }
    const pqBytes = encodeDenseVectorPack(idx5k, mat5k, {
      dim: 8,
      quantization: 'pq',
      pqSubspaces: 2,
      pqIterations: 2,
      pqSampleSize: 4096,
      representationVersion: 'pq-test:v1',
      snapshotId: 'snap-5k:v1',
    })
    const loaded5k = FrozenVectorIndex.loadBinary(pqBytes, idx5k, {
      representationVersion: 'pq-test:v1',
      snapshotId: 'snap-5k:v1',
    })
    expect(loaded5k.presentCount).toBe(5000)
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
    const vi = buildAnyDenseVectors(index, rawVecs, {
      dim: 4,
      quantization: 'float32',
      normalize: true,
    })
    rawVecs.fill(0)
    expect(vi.topK([1, 0, 0, 0], { k: 1 }).map((h) => h.id)).toEqual(['a'])

    expect(frozenMemoryBreakdown(index)).toEqual(beforeMem)
    expect(index.search('alpha').map((h) => h.id)).toEqual(['a'])
    expect(vi.scoreDocument([1, 0, 0, 0], 'a')).toBeCloseTo(1, 5)

    const nested = vi.topK([1, 0.5, 0, 0], {
      k: 2,
      filter: () => {
        const inner = vi.topK([0, 0, 1, 0], { k: 1 })
        return inner[0].id === 'c'
      },
    })
    expect(nested.map((h) => h.id)).toEqual(['a', 'b'])

    const packed = vi.saveBinary()
    const loaded = FrozenVectorIndex.loadBinary(packed, index, BASE_META)
    packed.fill(0xff)
    expect(loaded.scoreDocument([0, 1, 0, 0], 'b')).toBeCloseTo(1, 5)
  })
})

describe('FrozenVectorIndex snapshot/representation binding, ID policy & binary invariants (§2 & §3)', () => {
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
      const nodeVec = buildAnyDenseVectors(nodeIdx, mat, {
        dim: 16,
        quantization,
        metric: 'cosine',
        pqSubspaces: 4,
      })
      const bin = nodeVec.saveBinary()
      const unaligned = new Uint8Array(bin.length + 3)
      unaligned.set(bin, 3)

      const loadedBack = FrozenVectorIndex.loadBinary(
        unaligned.subarray(3),
        browserIdx,
        BASE_META,
      )
      expect(loadedBack.stats()).toEqual(nodeVec.stats())
      const q = makeUnitVec(16, 7)
      expect(loadedBack.topK(q, { k: 5 })).toEqual(nodeVec.topK(q, { k: 5 }))
    }
  })

  test('same-cardinality N: dense 0..N-1 permutation, modified content, model change & ID types', () => {
    const metaA = {
      representationVersion: 'model-v1:l2',
      snapshotId: 'sha256:corpus-order-a',
    }
    const metaPermuted = {
      representationVersion: 'model-v1:l2',
      snapshotId: 'sha256:corpus-order-b',
    }
    const metaModifiedContent = {
      representationVersion: 'model-v1:l2',
      snapshotId: 'sha256:corpus-content-modified',
    }
    const metaModelChanged = {
      representationVersion: 'model-v2:l2',
      snapshotId: 'sha256:corpus-order-a',
    }

    // 1. Dense 0..N-1 permutation (N = 2 on both!)
    const denseA = FrozenMiniSearch.fromDocuments(
      [
        { id: 0, text: 'paracetamol' },
        { id: 1, text: 'ibuprofene' },
      ],
      { fields: ['text'] },
    )
    const densePermuted = FrozenMiniSearch.fromDocuments(
      [
        { id: 0, text: 'ibuprofene' },
        { id: 1, text: 'paracetamol' },
      ],
      { fields: ['text'] },
    )
    expect(FrozenVectorIndex.mappingFingerprint(denseA)).toBe(
      FrozenVectorIndex.mappingFingerprint(densePermuted),
    )

    const denseVecs = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0])
    const viDenseA = FrozenVectorIndex.fromDenseFloat32(denseA, denseVecs, {
      dim: 4,
      quantization: 'float32',
      ...metaA,
    })
    const packDenseA = viDenseA.saveBinary()

    // Permuted dense host with its snapshotId must reject (same N, same 0..N-1 mappingFingerprint!)
    expect(() =>
      FrozenVectorIndex.loadBinary(packDenseA, densePermuted, metaPermuted),
    ).toThrow(/snapshotId mismatch/)
    expect(() =>
      viDenseA.assertCompatibleWith(densePermuted, metaPermuted),
    ).toThrow(/snapshotId mismatch/)

    // 2. Modified text content with identical stable external IDs (same N)
    const stableV1 = FrozenMiniSearch.fromDocuments(
      [
        { id: 'cis-1', text: 'amoxicilline comprimé' },
        { id: 'cis-2', text: 'doliprane gélule' },
      ],
      { fields: ['text'] },
    )
    const stableV2 = FrozenMiniSearch.fromDocuments(
      [
        { id: 'cis-1', text: 'amoxicilline sirop' },
        { id: 'cis-2', text: 'doliprane gélule' },
      ],
      { fields: ['text'] },
    )
    const packStable = FrozenVectorIndex.fromDenseFloat32(stableV1, denseVecs, {
      dim: 4,
      ...metaA,
    }).saveBinary()
    expect(() =>
      FrozenVectorIndex.loadBinary(packStable, stableV2, metaModifiedContent),
    ).toThrow(/snapshotId mismatch/)

    // 3. Changed model/preprocessing at equal dim (same N, same host)
    expect(() =>
      FrozenVectorIndex.loadBinary(packStable, stableV1, metaModelChanged),
    ).toThrow(/representationVersion mismatch/)

    // 4. Distinct ID types: numeric [0, 1] vs string ['0', '1'] vs [-0, 1]
    const strIdsIdx = FrozenMiniSearch.fromDocuments(
      [
        { id: '0', text: 'paracetamol' },
        { id: '1', text: 'ibuprofene' },
      ],
      { fields: ['text'] },
    )
    expect(FrozenVectorIndex.mappingFingerprint(denseA)).not.toBe(
      FrozenVectorIndex.mappingFingerprint(strIdsIdx),
    )
    expect(() =>
      FrozenVectorIndex.loadBinary(packDenseA, strIdsIdx, metaA),
    ).toThrow(/fingerprint mismatch/)

    // Missing expected metadata must fail closed
    expect(() => FrozenVectorIndex.loadBinary(packStable, stableV1)).toThrow(
      /expected metadata object/,
    )

    // 5. Unsupported external ID types rejected instead of collapsing to String(obj)
    const objHost = FrozenMiniSearch.fromDocuments(
      [
        { id: { code: 1 }, text: 'one' },
        { id: { code: 2 }, text: 'two' },
      ],
      { fields: ['text'] },
    )
    expect(() =>
      FrozenVectorIndex.fromDenseFloat32(objHost, denseVecs, {
        dim: 4,
        ...metaA,
      }),
    ).toThrow(/unsupported external document ID type/)

    // 6. Valid reload succeeds
    const validReloaded = FrozenVectorIndex.loadBinary(
      packStable,
      stableV1,
      metaA,
    )
    expect(validReloaded.representationVersion).toBe(
      metaA.representationVersion,
    )
    expect(validReloaded.snapshotId).toBe(metaA.snapshotId)
    expect(validReloaded.mappingFingerprint).toBe(
      FrozenVectorIndex.mappingFingerprint(stableV1),
    )
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

    const vi = buildAnyDocumentVectors(
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
    const loaded = FrozenVectorIndex.loadBinary(
      vi.saveBinary(),
      holeIndex,
      BASE_META,
    )
    expect(loaded.topK([0, 1, 0, 0], { k: 5 }).map((h) => h.id)).toEqual([
      'keep2',
      'keep0',
    ])

    const emptyIdx = FrozenMiniSearch.fromDocuments([], { fields: ['text'] })
    for (const quantization of ['float32', 'int8', 'pq']) {
      const emptyVec = buildAnyDenseVectors(emptyIdx, new Float32Array(0), {
        dim: 4,
        quantization,
      })
      expect(emptyVec.topK([1, 0, 0, 0])).toEqual([])
      expect(
        FrozenVectorIndex.loadBinary(
          emptyVec.saveBinary(),
          emptyIdx,
          BASE_META,
        ).stats().documentCount,
      ).toBe(0)
    }

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
    const posPack = buildAnyDenseVectors(
      idxPosZero,
      new Float32Array([1, 0, 0, 1]),
      { dim: 2 },
    ).saveBinary()
    expect(() =>
      FrozenVectorIndex.loadBinary(posPack, idxNegZero, BASE_META),
    ).toThrow(/fingerprint mismatch/)
  })

  test('rejects forged rowNorms on Int8 ([1,0] norm=0.5 -> cos 2) and unnormalized Float32 ([2,0] with normalize:true)', () => {
    const idxSingle = FrozenMiniSearch.fromDocuments(
      [{ id: 'only', text: 'unit' }],
      { fields: ['text'] },
    )

    // Counter-example 1: valid Int8 cosine pack for [1, 0] without mask;
    // forge rowNorm[0] at byte offset 40 to 0.5 and recompute CRCs.
    const i8SinglePack = buildAnyDenseVectors(
      idxSingle,
      new Float32Array([1, 0]),
      { dim: 2, quantization: 'int8', metric: 'cosine' },
    ).saveBinary()
    const forgedI8Norm = new Uint8Array(i8SinglePack)
    writeFloatLE(forgedI8Norm, 40, 0.5)
    expect(() =>
      FrozenVectorIndex.loadBinary(
        resealVectorBinary(forgedI8Norm),
        idxSingle,
        BASE_META,
      ),
    ).toThrow(/row norm mismatch/)

    // Counter-example 2: valid Float32 pack with normalize: true and no stored norms;
    // overwrite [1, 0] at byte offset 40 with [2, 0] keeping flags & recomputing CRCs.
    const f32NormPack = buildAnyDenseVectors(
      idxSingle,
      new Float32Array([1, 0]),
      { dim: 2, quantization: 'float32', metric: 'cosine', normalize: true },
    ).saveBinary()
    const forgedF32 = new Uint8Array(f32NormPack)
    writeFloatLE(forgedF32, 40, 2.0)
    expect(() =>
      FrozenVectorIndex.loadBinary(
        resealVectorBinary(forgedF32),
        idxSingle,
        BASE_META,
      ),
    ).toThrow(/unnormalized float32/)

    // Flag inconsistency checks: Float32 normalized + FLAG_HAS_ROW_NORMS (bit 2)
    const forgedF32Flag = new Uint8Array(f32NormPack)
    forgedF32Flag[7] |= 1 << 2
    expect(() =>
      FrozenVectorIndex.loadBinary(
        resealVectorBinary(forgedF32Flag),
        idxSingle,
        BASE_META,
      ),
    ).toThrow(/must not declare stored row norms/)

    // Int8 symmetric code -128 must be rejected
    const forgedInt8Code128 = new Uint8Array(i8SinglePack)
    // layout: 40 hdr + 4 rowNorm + 4 scale = offset 48 is codes[0]
    forgedInt8Code128[48] = 0x80 // -128 in signed int8
    expect(() =>
      FrozenVectorIndex.loadBinary(
        resealVectorBinary(forgedInt8Code128),
        idxSingle,
        BASE_META,
      ),
    ).toThrow(/outside symmetric \[-127, 127\]/)
  })

  test('small/large scales: rejects forged 1e-10 / 0 norms on 1e-6 vectors across float32/int8/pq, rejects subnormal unnormalized, and computes 1e-31 cosine accurately', () => {
    const idxSingle = FrozenMiniSearch.fromDocuments(
      [{ id: 'only', text: 'tiny' }],
      { fields: ['text'] },
    )
    const idxPair = FrozenMiniSearch.fromDocuments(
      [
        { id: 'tiny', text: 'tiny' },
        { id: 'zero', text: 'zero' },
      ],
      { fields: ['text'] },
    )
    const idxQuad = FrozenMiniSearch.fromDocuments(
      [
        { id: 'd0', text: 'tiny zero' },
        { id: 'd1', text: 'tiny one' },
        { id: 'd2', text: 'tiny two' },
        { id: 'd3', text: 'tiny three' },
      ],
      { fields: ['text'] },
    )

    // 1. Tampered small stored norm (expected ~1e-6, forged to 1e-10, 0, or 1e-4 relative drift; and non-zero forged norm on 0-row)
    const smallVec = new Float32Array([1e-6, 0, 0, 0])
    for (const quantization of ['float32', 'int8', 'pq']) {
      const targetIdx = quantization === 'pq' ? idxQuad : idxSingle
      const vecMat =
        quantization === 'pq'
          ? new Float32Array([
              1e-6, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 1e-6, 0, 0, 0, 0, 1e-6,
            ])
          : smallVec
      const pack = buildAnyDenseVectors(targetIdx, vecMat, {
        dim: 4,
        quantization,
        metric: 'cosine',
        normalize: false,
        pqSubspaces: 2,
      }).saveBinary()

      for (const forgedVal of [1e-10, 0, 1e-6 * 1.001]) {
        const forged = new Uint8Array(pack)
        writeFloatLE(forged, 40, forgedVal)
        expect(() =>
          FrozenVectorIndex.loadBinary(
            resealVectorBinary(forged),
            targetIdx,
            BASE_META,
          ),
        ).toThrow(/row norm|subnormal/)
      }

      // Within 1e-4 serialization tolerance: load succeeds, and operational score STILL uses reconstructed norm (~1, not forged!)
      const slightlyDrifted = new Uint8Array(pack)
      const view = new DataView(slightlyDrifted.buffer)
      const expectedNorm = view.getFloat32(40, true)
      writeFloatLE(slightlyDrifted, 40, expectedNorm * (1 - 5e-5))
      const loadedDrifted = FrozenVectorIndex.loadBinary(
        resealVectorBinary(slightlyDrifted),
        targetIdx,
        BASE_META,
      )
      expect(
        loadedDrifted.scoreDocument(
          smallVec,
          quantization === 'pq' ? 'd0' : 'only',
        ),
      ).toBeCloseTo(1, 5)
    }

    // Zero vector must reject forged non-zero norm (even 1e-10 or 1e-6)
    const pairF32Pack = buildAnyDenseVectors(
      idxPair,
      new Float32Array([1e-6, 0, 0, 0]),
      { dim: 2, quantization: 'float32', metric: 'cosine', normalize: false },
    ).saveBinary()
    for (const forgedZeroNorm of [1e-10, 1e-6]) {
      const forged = new Uint8Array(pairF32Pack)
      writeFloatLE(forged, 44, forgedZeroNorm)
      expect(() =>
        FrozenVectorIndex.loadBinary(
          resealVectorBinary(forged),
          idxPair,
          BASE_META,
        ),
      ).toThrow(/row norm|subnormal/)
    }

    // 2. Normal tiny vector [1e-31, 0] with normalize:false -> cosine MUST be ~1 (never silent 0!)
    for (const quantization of ['float32', 'int8']) {
      const tinyIdx = buildAnyDenseVectors(
        idxPair,
        new Float32Array([1e-31, 0, 0, 0]),
        { dim: 2, quantization, metric: 'cosine', normalize: false },
      )
      expect(tinyIdx.scoreDocument([1e-31, 0], 'tiny')).toBeCloseTo(1, 5)
      expect(tinyIdx.scoreDocument([1e-31, 0], 'zero')).toBe(0)
      const top = tinyIdx.topK([1e-31, 0], { k: 2 })
      expect(top[0].id).toBe('tiny')
      expect(top[0].score).toBeCloseTo(1, 5)

      const reloadedTiny = FrozenVectorIndex.loadBinary(
        tinyIdx.saveBinary(),
        idxPair,
        BASE_META,
      )
      expect(reloadedTiny.scoreDocument([1e-31, 0], 'tiny')).toBeCloseTo(1, 5)
    }

    // PQ at 1e-31 without normalization also computes cosine ~1 accurately
    const pqTiny = buildAnyDenseVectors(
      idxQuad,
      new Float32Array([
        1e-31, 0, 0, 0, 0, 1e-31, 0, 0, 0, 0, 1e-31, 0, 0, 0, 0, 1e-31,
      ]),
      {
        dim: 4,
        quantization: 'pq',
        metric: 'cosine',
        normalize: false,
        pqSubspaces: 2,
      },
    )
    expect(pqTiny.scoreDocument([1e-31, 0, 0, 0], 'd0')).toBeCloseTo(1, 5)

    // 3. Large unnormalized cosine [1e30, 0] also works accurately
    const hugeIdx = buildAnyDenseVectors(
      idxSingle,
      new Float32Array([1e30, 0]),
      { dim: 2, quantization: 'float32', metric: 'cosine', normalize: false },
    )
    expect(hugeIdx.scoreDocument([1e30, 0], 'only')).toBeCloseTo(1, 5)

    // 4. Out-of-domain unnormalized subnormal/underflow non-zero vectors are rejected clearly
    expect(() =>
      buildAnyDenseVectors(idxSingle, new Float32Array([1e-40, 0]), {
        dim: 2,
        quantization: 'float32',
        metric: 'cosine',
        normalize: false,
      }),
    ).toThrow(/normal float32 range/)
    expect(() =>
      buildAnyDenseVectors(idxSingle, new Float32Array([1e-40, 0]), {
        dim: 2,
        quantization: 'int8',
        metric: 'cosine',
        normalize: false,
      }),
    ).toThrow(/normal float32 range/)
    expect(() =>
      buildAnyDocumentVectors(idxSingle, [['only', [1e-300, 0]]], {
        dim: 2,
        quantization: 'float32',
        metric: 'dot',
        normalize: false,
      }),
    ).toThrow(/float32 underflow/)

    // Subnormal [1e-40, 0] with normalize:true is scaled in float64 and succeeds cleanly
    const normalizedTiny = buildAnyDocumentVectors(
      idxSingle,
      [['only', [1e-40, 0]]],
      { dim: 2, quantization: 'float32', metric: 'cosine', normalize: true },
    )
    expect(normalizedTiny.scoreDocument([1e-40, 0], 'only')).toBeCloseTo(1, 5)
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
    const f32Vec = buildAnyDenseVectors(
      idxA,
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
      { dim: 4, quantization: 'float32', metric: 'dot' },
    )
    const pack = f32Vec.saveBinary()

    expect(() =>
      FrozenVectorIndex.loadBinary(pack, idxSwapped, BASE_META),
    ).toThrow(/fingerprint mismatch/)
    expect(() => f32Vec.assertCompatibleWith(idxSwapped, BASE_META)).toThrow(
      /fingerprint mismatch/,
    )

    expect(() =>
      FrozenVectorIndex.loadBinary(pack.subarray(0, 10), idxA, BASE_META),
    ).toThrow(/too short/)
    const badMagic = new Uint8Array(pack)
    badMagic[0] = 0x58
    expect(() =>
      FrozenVectorIndex.loadBinary(badMagic, idxA, BASE_META),
    ).toThrow(/magic/)

    const badVer = new Uint8Array(pack)
    badVer[4] = 99
    expect(() =>
      FrozenVectorIndex.loadBinary(resealVectorBinary(badVer), idxA, BASE_META),
    ).toThrow(/version/)

    const badHdrCrc = new Uint8Array(pack)
    badHdrCrc[8] ^= 1
    expect(() =>
      FrozenVectorIndex.loadBinary(badHdrCrc, idxA, BASE_META),
    ).toThrow(/header CRC-32/)

    const badPayCrc = new Uint8Array(pack)
    badPayCrc[badPayCrc.length - 1] ^= 1
    expect(() =>
      FrozenVectorIndex.loadBinary(badPayCrc, idxA, BASE_META),
    ).toThrow(/payload CRC-32/)

    const trailing = new Uint8Array(pack.length + 1)
    trailing.set(pack)
    expect(() =>
      FrozenVectorIndex.loadBinary(trailing, idxA, BASE_META),
    ).toThrow(/byte length mismatch/)

    const forgedNan = new Uint8Array(pack)
    new DataView(forgedNan.buffer).setFloat32(40, Number.NaN, true)
    expect(() =>
      FrozenVectorIndex.loadBinary(
        resealVectorBinary(forgedNan),
        idxA,
        BASE_META,
      ),
    ).toThrow(/non-finite/)

    const i8Pack = buildAnyDenseVectors(
      idxA,
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
      { dim: 4, quantization: 'int8', metric: 'cosine' },
    ).saveBinary()
    const forgedNegNorm = new Uint8Array(i8Pack)
    new DataView(forgedNegNorm.buffer).setFloat32(40, -1, true)
    expect(() =>
      FrozenVectorIndex.loadBinary(
        resealVectorBinary(forgedNegNorm),
        idxA,
        BASE_META,
      ),
    ).toThrow(/negative row norm/)

    expect(() =>
      FrozenVectorIndex.fromDenseFloat32(
        idxA,
        new Float32Array([1, Number.NaN, 0, 0, 0, 0, 0, 0]),
        withMeta({ dim: 4 }),
      ),
    ).toThrow(/non-finite/)
    expect(() =>
      FrozenVectorIndex.fromDocumentVectors(
        idxA,
        [['doc1', [1, 0, 0, 0]]],
        withMeta({ dim: 4 }),
      ),
    ).toThrow(/expected 2 live/)
    expect(() =>
      FrozenVectorIndex.fromDocumentVectors(
        idxA,
        [['missing', [1, 0, 0, 0]]],
        withMeta({ dim: 4, requireAllLiveDocs: false }),
      ),
    ).toThrow(/unknown document id/)
  })
})
