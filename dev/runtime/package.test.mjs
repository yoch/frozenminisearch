import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import zlib from 'node:zlib'
import * as esm from '@yoch/frozenminisearch'
import * as browser from '@yoch/frozenminisearch/browser'
import * as vectors from '@yoch/frozenminisearch/vectors'
import * as vectorsTrain from '@yoch/frozenminisearch/vectors/train'

const require = createRequire(import.meta.url)
const cjs = require('@yoch/frozenminisearch')
const documents = [
  { id: 'book-1', title: 'Moby Dick', text: 'Call me Ishmael', category: 'fiction' },
  { id: 'book-2', title: 'Zen', text: 'The art of motorcycle maintenance', category: 'nonfiction' },
  { id: 'book-3', title: 'Zen stories', text: 'Fictional zen art 😀 😁', category: 'fiction' },
]
const options = { fields: ['title', 'text'], storeFields: ['title', 'category'] }

for (const [name, entry] of [['ESM', esm], ['CommonJS', cjs], ['browser', browser]]) {
  const FrozenMiniSearch = entry.default

  test(`${name}: package exports, search, and suggestions`, () => {
    assert.equal(entry.FrozenMiniSearch, FrozenMiniSearch)
    if (name === 'CommonJS') assert.equal(cjs, FrozenMiniSearch)
    const index = FrozenMiniSearch.fromDocuments(documents, options)
    assert.deepEqual(index.search('ishmal', { fuzzy: 0.3 }).map(hit => hit.id), ['book-1'])
    assert.deepEqual(index.search('zen', {
      prefix: true,
      filter: hit => hit.category === 'fiction',
    }).map(hit => hit.id), ['book-3'])
    assert.ok(index.autoSuggest('zen ar').some(hit => hit.terms.includes('art')))
    assert.equal(index.has('book-2'), true)
    assert.deepEqual(index.getStoredFields('book-1'), { title: 'Moby Dick', category: 'fiction' })
  })

  test(`${name}: incremental builder and JSON import`, () => {
    const builder = entry.createFrozenIndexBuilder(options)
    builder.addAll(documents)
    const built = entry.freezeFrozenIndexBuilder(builder)
    const loaded = FrozenMiniSearch.fromJSON(JSON.stringify(built), options)
    assert.deepEqual(loaded.search('zen art', { combineWith: 'AND' }), built.search('zen art', { combineWith: 'AND' }))
  })

  for (const compression of ['raw', 'zlib', 'auto']) {
    test(`${name}: async binary round trip (${compression})`, async () => {
      const index = FrozenMiniSearch.fromDocuments(documents, options)
      const bytes = await index.saveBinaryAsync({ compression })
      const loaded = await FrozenMiniSearch.loadBinaryAsync(new Uint8Array(bytes), options)
      assert.deepEqual(loaded.search('zen', { limit: 1 }), index.search('zen', { limit: 1 }))
      assert.deepEqual(loaded.search('😀'), index.search('😀'))
      assert.deepEqual(loaded.search('😁'), index.search('😁'))
      assert.deepEqual(loaded.getStoredFields('book-1'), index.getStoredFields('book-1'))
    })
  }

  if (name !== 'browser') {
    for (const compression of ['raw', 'zlib', 'auto']) {
      test(`${name}: synchronous binary round trip (${compression})`, () => {
        const index = FrozenMiniSearch.fromDocuments(documents, options)
        const bytes = index.saveBinarySync({ compression })
        const loaded = FrozenMiniSearch.loadBinarySync(new Uint8Array(bytes), options)
        assert.deepEqual(loaded.search('zen'), index.search('zen'))
        assert.deepEqual(loaded.search('😀'), index.search('😀'))
      })
    }

    test(`${name}: zstd capability follows the runtime`, () => {
      const index = FrozenMiniSearch.fromDocuments(documents, options)
      if (typeof zlib.zstdCompressSync === 'function') {
        const loaded = FrozenMiniSearch.loadBinarySync(index.saveBinarySync({ compression: 'zstd' }), options)
        assert.deepEqual(loaded.search('zen'), index.search('zen'))
      } else {
        assert.throws(() => index.saveBinarySync({ compression: 'zstd' }), /zstd/)
      }
    })
  }
}

test('Node and browser exchange zlib snapshots', async () => {
  const nodeIndex = esm.default.fromDocuments(documents, options)
  const browserIndex = browser.default.fromDocuments(documents, options)
  const inBrowser = await browser.default.loadBinaryAsync(new Uint8Array(nodeIndex.saveBinarySync({ compression: 'zlib' })), options)
  const inNode = esm.default.loadBinarySync(await browserIndex.saveBinaryAsync({ compression: 'zlib' }), options)
  assert.deepEqual(inBrowser.search('zen'), nodeIndex.search('zen'))
  assert.deepEqual(inNode.search('zen'), browserIndex.search('zen'))
})

test('vectors and vectors/train subpaths work across ESM, CJS and browser host with FXV1 v2 invariants', () => {
  const cjsVectors = require('@yoch/frozenminisearch/vectors')
  const cjsTrain = require('@yoch/frozenminisearch/vectors/train')
  assert.equal(esm.FrozenVectorIndex, undefined)
  assert.equal(cjs.FrozenVectorIndex, undefined)
  assert.equal(browser.FrozenVectorIndex, undefined)

  const nodeHost = esm.default.fromDocuments(documents, options)
  const browserHost = browser.default.fromDocuments(documents, options)
  const meta = { representationVersion: 'runtime:v1', snapshotId: 'docs:v1' }
  const entries = [
    ['book-1', [1, 0, 0, 0]],
    ['book-2', [0, 1, 0, 0]],
    ['book-3', [0.7, 0.7, 0, 0]],
  ]

  const i8 = vectors.FrozenVectorIndex.fromDocumentVectors(nodeHost, entries, {
    dim: 4,
    quantization: 'int8',
    normalize: true,
    ...meta,
  })
  const loadedCjs = cjsVectors.FrozenVectorIndex.loadBinary(
    i8.saveBinary(),
    browserHost,
    meta,
  )
  assert.equal(loadedCjs.topK([0, 1, 0, 0], { k: 1 })[0].id, 'book-2')

  const pqBytes = cjsTrain.encodeDocumentVectorPack(nodeHost, entries, {
    dim: 4,
    quantization: 'pq',
    pqSubspaces: 2,
    normalize: true,
    ...meta,
  })
  const loadedPq = vectors.FrozenVectorIndex.loadBinary(
    pqBytes,
    nodeHost,
    meta,
  )
  assert.equal(loadedPq.topK([1, 0, 0, 0], { k: 1 })[0].id, 'book-1')
  assert.equal(
    vectorsTrain.selectPqSampleIndices(new Int32Array([0, 1, 2, 3, 4]), 3).length,
    3,
  )
})

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c >>> 0
  }
  return t
})()

function crc32Bytes(u8) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(u8) >>> 0
  let c = 0xffffffff
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function resealFxv1Pack(bytes) {
  const copy = new Uint8Array(bytes)
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  view.setUint32(32, crc32Bytes(copy.subarray(40)), true)
  view.setUint32(36, crc32Bytes(copy.subarray(0, 36)), true)
  return copy
}

test('built package rejects tampered stored norms on float32/int8/pq and preserves small/large domains', () => {
  const hostSingle = esm.default.fromDocuments([{ id: 'd0', text: 'tiny' }], { fields: ['text'] })
  const hostQuad = esm.default.fromDocuments(
    [
      { id: 'd0', text: 'alpha' },
      { id: 'd1', text: 'beta' },
      { id: 'd2', text: 'gamma' },
      { id: 'd3', text: 'delta' },
    ],
    { fields: ['text'] },
  )
  const meta = { representationVersion: 'pkg-norm:v1', snapshotId: 'snap-norm:v1' }

  // 1. Probe on Float32 FXV1 v2 (1e-6 vector, forged 1e-10 or 0 stored norm with recomputed CRCs)
  const f32Small = vectors.FrozenVectorIndex.fromDenseFloat32(
    hostSingle,
    new Float32Array([1e-6, 0]),
    { dim: 2, quantization: 'float32', metric: 'cosine', normalize: false, ...meta },
  )
  const i8Small = vectors.FrozenVectorIndex.fromDenseFloat32(
    hostSingle,
    new Float32Array([1e-6, 0]),
    { dim: 2, quantization: 'int8', metric: 'cosine', normalize: false, ...meta },
  )
  const pqSmallBytes = vectorsTrain.encodeDenseVectorPack(
    hostQuad,
    new Float32Array([1e-6, 0, 0, 1e-6, 1e-6, 1e-6, 0, 0]),
    { dim: 2, quantization: 'pq', metric: 'cosine', normalize: false, pqSubspaces: 1, ...meta },
  )

  for (const [label, targetHost, rawPack] of [
    ['float32', hostSingle, f32Small.saveBinary()],
    ['int8', hostSingle, i8Small.saveBinary()],
    ['pq', hostQuad, pqSmallBytes],
  ]) {
    for (const forgedNorm of [1e-10, 0]) {
      const forged = new Uint8Array(rawPack)
      new DataView(forged.buffer, forged.byteOffset, forged.byteLength).setFloat32(40, forgedNorm, true)
      assert.throws(
        () => vectors.FrozenVectorIndex.loadBinary(resealFxv1Pack(forged), targetHost, meta),
        /row norm|subnormal/,
        `${label} pack with forged norm ${forgedNorm} must be rejected`,
      )
    }
  }

  // 2. [1e-31, 0] unnormalized cosine computes ~1 across float32 and int8; [1e-40, 0] rejected cleanly
  for (const quantization of ['float32', 'int8']) {
    const tinyIndex = vectors.FrozenVectorIndex.fromDenseFloat32(
      hostSingle,
      new Float32Array([1e-31, 0]),
      { dim: 2, quantization, metric: 'cosine', normalize: false, ...meta },
    )
    const score = tinyIndex.scoreDocument([1e-31, 0], 'd0')
    assert.ok(Math.abs(score - 1) < 1e-5, `${quantization} [1e-31,0] score expected ~1, got ${score}`)
    const reloaded = vectors.FrozenVectorIndex.loadBinary(tinyIndex.saveBinary(), hostSingle, meta)
    assert.ok(Math.abs(reloaded.topK([1e-31, 0], { k: 1 })[0].score - 1) < 1e-5)

    assert.throws(
      () => vectors.FrozenVectorIndex.fromDenseFloat32(
        hostSingle,
        new Float32Array([1e-40, 0]),
        { dim: 2, quantization, metric: 'cosine', normalize: false, ...meta },
      ),
      /normal float32 range/,
    )
  }

  // 3. Normalization across 1e40, 1e300, 1e-300 on built package
  const normHost = esm.default.fromDocuments(
    [{ id: 'diag', text: 'd' }, { id: 'ortho', text: 'o' }],
    { fields: ['text'] },
  )
  const normVec = vectors.FrozenVectorIndex.fromDocumentVectors(
    normHost,
    [['diag', [1e300, 1e300]], ['ortho', [0, 1e40]]],
    { dim: 2, quantization: 'int8', metric: 'cosine', normalize: true, ...meta },
  )
  assert.ok(Math.abs(normVec.scoreDocument([1e-300, 1e-300], 'diag') - 1) < 1e-2)
  assert.ok(Math.abs(normVec.scoreDocument([1e40, 1e40], 'diag') - 1) < 1e-2)
  assert.ok(Math.abs(normVec.scoreDocument([1e300, 1e300], 'diag') - 1) < 1e-2)
})
