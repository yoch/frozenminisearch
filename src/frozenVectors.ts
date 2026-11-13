import {
  assertLittleEndianHost,
  readAscii,
  readU16LE,
  readU32LE,
  readU8,
  snapshotBytes,
  utf8Bytes,
  writeAscii,
  writeU16LE,
  writeU32LE,
  writeU8,
} from './binaryBytes'
import { crc32Update } from './crc32Wire'
import {
  VECTOR_CORPUS_BINDING,
  type VectorCorpusBinding,
  type VectorCorpusHost,
} from './frozenVectorBinding'

const VECTOR_MAGIC = 'FXV1'
const VECTOR_VERSION = 1
const VECTOR_HEADER_SIZE = 40

const KIND_FLOAT32 = 1
const KIND_INT8 = 2
const KIND_PQ_U8 = 3

const FLAG_NORMALIZED = 1 << 0
const FLAG_HAS_PRESENT_MASK = 1 << 1
const FLAG_HAS_ROW_NORMS = 1 << 2
const FLAG_METRIC_COSINE = 1 << 3
const KNOWN_FLAGS =
  FLAG_NORMALIZED |
  FLAG_HAS_PRESENT_MASK |
  FLAG_HAS_ROW_NORMS |
  FLAG_METRIC_COSINE

const MAX_DIM = 65536
const MAX_PAYLOAD_BYTES = 0x7fffffff

const FP_TAG_HOLE = 0
const FP_TAG_STRING = 1
const FP_TAG_NUMBER = 2
const FP_TAG_OTHER = 3

const FLOAT_SCRATCH = new ArrayBuffer(8)
const FLOAT_SCRATCH_VIEW = new DataView(FLOAT_SCRATCH)
const FLOAT_SCRATCH_BYTES = new Uint8Array(FLOAT_SCRATCH)
const U32_SCRATCH = new Uint8Array(9)
const FP_HEADER_SCRATCH = new Uint8Array(10)

export type VectorQuantization = 'float32' | 'int8' | 'pq'
export type VectorMetric = 'cosine' | 'dot'

export interface VectorIndexOptions {
  /** Embedding dimensionality (`1 <= dim <= 65536`). */
  dim: number
  /** Compression mode (`'float32'`, `'int8'`, or `'pq'`). Defaults to `'int8'`. */
  quantization?: VectorQuantization
  /** Similarity metric (`'cosine'` or `'dot'`). Defaults to `'cosine'`. */
  metric?: VectorMetric
  /** L2-normalize each live vector prior to quantization. Defaults to `false`. */
  normalize?: boolean
  /** Number of PQ subspaces dividing `dim` (`quantization: 'pq'`). */
  pqSubspaces?: number
  /** K-means iterations per subspace (`quantization: 'pq'`). Defaults to `12`. */
  pqIterations?: number
  /** Deterministic sample cap per PQ subspace (`quantization: 'pq'`). Defaults to `4096`. */
  pqSampleSize?: number
}

export type DocumentVectorEntry<Id = unknown> =
  { id: Id; vector: ArrayLike<number> } | readonly [Id, ArrayLike<number>]

export interface FromDocumentVectorsOptions extends VectorIndexOptions {
  /** Reject missing vectors for any live document in the corpus. Defaults to `true`. */
  requireAllLiveDocs?: boolean
}

export interface VectorSearchOptions<Id = unknown> {
  /** Maximum number of hits to return (`0` returns `[]`). Defaults to `10`. */
  k?: number
  /** Override query metric (`'cosine'` or `'dot'`). Defaults to the index metric. */
  metric?: VectorMetric
  /** Minimum similarity threshold (`score >= minScore`). Defaults to `-Infinity`. */
  minScore?: number
  /** Pre-k document predicate evaluated before heap insertion. */
  filter?: (id: Id, shortId: number) => boolean
}

export interface VectorSearchHit<Id = unknown> {
  id: Id
  shortId: number
  score: number
}

export interface FrozenVectorIndexStats {
  quantization: VectorQuantization
  metric: VectorMetric
  dim: number
  documentCount: number
  nextId: number
  corpusFingerprint: number
  presentCount: number
  pqSubspaces: number
  pqCentroidsPerSubspace: number
  normalized: boolean
  hasReconstructedNorms: boolean
  byteLength: number
}

type VectorPayload =
  | { kind: typeof KIND_FLOAT32; vectors: Float32Array }
  | { kind: typeof KIND_INT8; scales: Float32Array; codes: Int8Array }
  | {
      kind: typeof KIND_PQ_U8
      subspaces: number
      centroidsPerSubspace: number
      subDim: number
      centroids: Float32Array
      codes: Uint8Array
    }

function assertNonNegInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `FrozenVectorIndex: ${label} must be a non-negative integer`,
    )
  }
}

function assertDim(dim: number): void {
  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) {
    throw new RangeError(
      `FrozenVectorIndex: dim must be an integer in [1, ${MAX_DIM}]`,
    )
  }
}

function assertMetric(metric: VectorMetric): void {
  if (metric !== 'cosine' && metric !== 'dot') {
    throw new TypeError(
      `FrozenVectorIndex: unsupported metric "${String(metric)}"`,
    )
  }
}

function readCorpusBinding(host: unknown): VectorCorpusBinding {
  if (
    host == null ||
    typeof host !== 'object' ||
    typeof (host as VectorCorpusHost)[VECTOR_CORPUS_BINDING] !== 'function'
  ) {
    throw new TypeError(
      'FrozenVectorIndex: expected a FrozenMiniSearch instance',
    )
  }
  const binding = (host as VectorCorpusHost)[VECTOR_CORPUS_BINDING]()
  assertNonNegInt(binding.documentCount, 'documentCount')
  assertNonNegInt(binding.nextId, 'nextId')
  if (binding.documentCount > binding.nextId) {
    throw new RangeError(
      'FrozenVectorIndex: documentCount exceeds nextId on host corpus',
    )
  }
  if (
    binding.externalIds !== null &&
    binding.externalIds.length < binding.nextId
  ) {
    throw new RangeError(
      'FrozenVectorIndex: host externalIds shorter than nextId',
    )
  }
  return binding
}

function resolveExternalId(
  binding: VectorCorpusBinding,
  shortId: number,
): unknown {
  return binding.externalIds === null ? shortId : binding.externalIds[shortId]
}

function isLiveShortId(binding: VectorCorpusBinding, shortId: number): boolean {
  return (
    binding.externalIds === null || binding.externalIds[shortId] !== undefined
  )
}

function writeU32At(buf: Uint8Array, pos: number, value: number): void {
  buf[pos] = value & 0xff
  buf[pos + 1] = (value >>> 8) & 0xff
  buf[pos + 2] = (value >>> 16) & 0xff
  buf[pos + 3] = (value >>> 24) & 0xff
}

function hashTagShortId(seed: number, tag: number, shortId: number): number {
  U32_SCRATCH[0] = tag & 0xff
  writeU32At(U32_SCRATCH, 1, shortId)
  return crc32Update(seed, U32_SCRATCH, 0, 5)
}

/** Compute deterministic CRC-32 fingerprint binding document slots and external IDs. */
function computeCorpusFingerprint(binding: VectorCorpusBinding): number {
  FP_HEADER_SCRATCH[0] = 1
  FP_HEADER_SCRATCH[1] = binding.externalIds === null ? 1 : 2
  writeU32At(FP_HEADER_SCRATCH, 2, binding.documentCount)
  writeU32At(FP_HEADER_SCRATCH, 6, binding.nextId)
  let seed = crc32Update(0, FP_HEADER_SCRATCH, 0, FP_HEADER_SCRATCH.length)
  if (binding.externalIds === null) {
    return seed >>> 0
  }

  const externalIds = binding.externalIds
  for (let shortId = 0; shortId < binding.nextId; shortId++) {
    const ext = externalIds[shortId]
    if (ext === undefined) {
      seed = hashTagShortId(seed, FP_TAG_HOLE, shortId)
      continue
    }
    if (typeof ext === 'string') {
      const encoded = utf8Bytes(ext)
      U32_SCRATCH[0] = FP_TAG_STRING
      writeU32At(U32_SCRATCH, 1, shortId)
      writeU32At(U32_SCRATCH, 5, encoded.length)
      seed = crc32Update(seed, U32_SCRATCH, 0, 9)
      seed = crc32Update(seed, encoded, 0, encoded.length)
    } else if (typeof ext === 'number') {
      seed = hashTagShortId(seed, FP_TAG_NUMBER, shortId)
      FLOAT_SCRATCH_VIEW.setFloat64(0, ext, true)
      seed = crc32Update(seed, FLOAT_SCRATCH_BYTES, 0, 8)
    } else {
      const encoded = utf8Bytes(String(ext))
      U32_SCRATCH[0] = FP_TAG_OTHER
      writeU32At(U32_SCRATCH, 1, shortId)
      writeU32At(U32_SCRATCH, 5, encoded.length)
      seed = crc32Update(seed, U32_SCRATCH, 0, 9)
      seed = crc32Update(seed, encoded, 0, encoded.length)
    }
  }
  return seed >>> 0
}

function presentMaskByteLength(nextId: number): number {
  return (nextId + 7) >>> 3
}

function isMaskBitSet(mask: Uint8Array, index: number): boolean {
  return ((mask[index >>> 3] >>> (index & 7)) & 1) !== 0
}

function setMaskBit(mask: Uint8Array, index: number): void {
  mask[index >>> 3] |= 1 << (index & 7)
}

function countMaskBits(mask: Uint8Array, nextId: number): number {
  let count = 0
  for (let i = 0; i < nextId; i++) {
    if (isMaskBitSet(mask, i)) count++
  }
  return count
}

function resolvePqSubspaces(dim: number, requested?: number): number {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1 || requested > dim) {
      throw new RangeError(
        `FrozenVectorIndex: pqSubspaces must be an integer in [1, ${dim}]`,
      )
    }
    if (dim % requested !== 0) {
      throw new RangeError(
        `FrozenVectorIndex: dim (${dim}) must be divisible by pqSubspaces (${requested})`,
      )
    }
    return requested
  }
  for (const candidate of [16, 32, 8, 4, 2, 1]) {
    if (dim % candidate === 0 && (dim / candidate >= 4 || candidate === 1)) {
      return candidate
    }
  }
  for (let m = Math.min(16, dim); m >= 1; m--) {
    if (dim % m === 0) return m
  }
  return 1
}

function normalizeOrCopyRow(
  src: ArrayLike<number>,
  srcOffset: number,
  dst: Float32Array,
  dstOffset: number,
  dim: number,
  normalize: boolean,
  docLabel: string | number,
): void {
  let norm2 = 0
  for (let d = 0; d < dim; d++) {
    const val = src[srcOffset + d]
    if (!Number.isFinite(val)) {
      throw new RangeError(
        `FrozenVectorIndex: non-finite value at ${docLabel}, dim ${d}`,
      )
    }
    dst[dstOffset + d] = val
    norm2 += val * val
  }
  if (normalize && norm2 > 1e-24) {
    const inv = 1 / Math.sqrt(norm2)
    for (let d = 0; d < dim; d++) {
      dst[dstOffset + d] *= inv
    }
  }
}

function buildInt8Payload(
  vectors: Float32Array,
  nextId: number,
  dim: number,
  presentMask: Uint8Array | null,
): VectorPayload {
  const scales = new Float32Array(nextId)
  const codes = new Int8Array(nextId * dim)

  for (let i = 0; i < nextId; i++) {
    if (presentMask !== null && !isMaskBitSet(presentMask, i)) continue
    const base = i * dim
    let maxAbs = 0
    for (let d = 0; d < dim; d++) {
      const a = Math.abs(vectors[base + d])
      if (a > maxAbs) maxAbs = a
    }
    if (maxAbs <= 1e-12) {
      scales[i] = 0
      continue
    }
    const scale = maxAbs / 127
    scales[i] = scale
    const inv = 1 / scale
    for (let d = 0; d < dim; d++) {
      const q = Math.round(vectors[base + d] * inv)
      codes[base + d] = q > 127 ? 127 : q < -127 ? -127 : q
    }
  }
  return { kind: KIND_INT8, scales, codes }
}

function buildPqPayload(
  vectors: Float32Array,
  nextId: number,
  dim: number,
  presentMask: Uint8Array | null,
  presentCount: number,
  options: VectorIndexOptions,
): VectorPayload {
  const subspaces = resolvePqSubspaces(dim, options.pqSubspaces)
  const subDim = dim / subspaces
  const iters = options.pqIterations ?? 12
  if (!Number.isInteger(iters) || iters < 1) {
    throw new RangeError('FrozenVectorIndex: pqIterations must be integer >= 1')
  }
  const maxSamples = options.pqSampleSize ?? 4096
  if (!Number.isInteger(maxSamples) || maxSamples < 1) {
    throw new RangeError('FrozenVectorIndex: pqSampleSize must be integer >= 1')
  }

  const liveShortIds = new Int32Array(presentCount)
  let li = 0
  for (let i = 0; i < nextId; i++) {
    if (presentMask === null || isMaskBitSet(presentMask, i)) {
      liveShortIds[li++] = i
    }
  }

  const centroidsPerSubspace =
    presentCount > 0 ? Math.min(256, presentCount) : 1
  const centroids = new Float32Array(subspaces * centroidsPerSubspace * subDim)
  const codes = new Uint8Array(nextId * subspaces)
  if (presentCount === 0) {
    return {
      kind: KIND_PQ_U8,
      subspaces,
      centroidsPerSubspace,
      subDim,
      centroids,
      codes,
    }
  }

  const sampleStep = Math.max(1, Math.floor(presentCount / maxSamples))
  const sampleIds: number[] = []
  for (let i = 0; i < presentCount; i += sampleStep) {
    sampleIds.push(liveShortIds[i])
  }
  const S = sampleIds.length

  let seed = 0x1234567
  const sums = new Float64Array(centroidsPerSubspace * subDim)
  const counts = new Int32Array(centroidsPerSubspace)

  for (let m = 0; m < subspaces; m++) {
    const cBase = m * centroidsPerSubspace * subDim
    const colOffset = m * subDim

    for (let k = 0; k < centroidsPerSubspace; k++) {
      let docIdx: number
      if (centroidsPerSubspace === presentCount) {
        docIdx = liveShortIds[k]
      } else {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        docIdx = sampleIds[seed % S]
      }
      const src = docIdx * dim + colOffset
      const dst = cBase + k * subDim
      for (let d = 0; d < subDim; d++) {
        centroids[dst + d] = vectors[src + d]
      }
    }

    for (let it = 0; it < iters; it++) {
      sums.fill(0)
      counts.fill(0)
      for (let si = 0; si < S; si++) {
        const docBase = sampleIds[si] * dim + colOffset
        let bestK = 0
        let bestDist = Infinity
        for (let k = 0; k < centroidsPerSubspace; k++) {
          const kb = cBase + k * subDim
          let dist = 0
          for (let d = 0; d < subDim; d++) {
            const diff = vectors[docBase + d] - centroids[kb + d]
            dist += diff * diff
          }
          if (dist < bestDist) {
            bestDist = dist
            bestK = k
          }
        }
        counts[bestK]++
        const sb = bestK * subDim
        for (let d = 0; d < subDim; d++) {
          sums[sb + d] += vectors[docBase + d]
        }
      }
      for (let k = 0; k < centroidsPerSubspace; k++) {
        const cnt = counts[k]
        if (cnt > 0) {
          const kb = cBase + k * subDim
          const sb = k * subDim
          const inv = 1 / cnt
          for (let d = 0; d < subDim; d++) {
            centroids[kb + d] = sums[sb + d] * inv
          }
        }
      }
    }

    for (let liIdx = 0; liIdx < presentCount; liIdx++) {
      const docId = liveShortIds[liIdx]
      const docBase = docId * dim + colOffset
      let bestK = 0
      let bestDist = Infinity
      for (let k = 0; k < centroidsPerSubspace; k++) {
        const kb = cBase + k * subDim
        let dist = 0
        for (let d = 0; d < subDim; d++) {
          const diff = vectors[docBase + d] - centroids[kb + d]
          dist += diff * diff
        }
        if (dist < bestDist) {
          bestDist = dist
          bestK = k
        }
      }
      codes[docId * subspaces + m] = bestK
    }
  }

  return {
    kind: KIND_PQ_U8,
    subspaces,
    centroidsPerSubspace,
    subDim,
    centroids,
    codes,
  }
}

function buildPayloadFromFloat32(
  vectors: Float32Array,
  nextId: number,
  dim: number,
  presentMask: Uint8Array | null,
  presentCount: number,
  options: VectorIndexOptions,
): VectorPayload {
  const quant = options.quantization ?? 'int8'
  if (quant === 'float32') {
    return { kind: KIND_FLOAT32, vectors }
  }
  if (quant === 'int8') {
    return buildInt8Payload(vectors, nextId, dim, presentMask)
  }
  if (quant === 'pq') {
    return buildPqPayload(
      vectors,
      nextId,
      dim,
      presentMask,
      presentCount,
      options,
    )
  }
  throw new TypeError(
    `FrozenVectorIndex: unsupported quantization "${String(quant)}"`,
  )
}

/**
 * Compute exact L2 norms of the reconstructed vectors (NOT pre-rounding input norms)
 * so cosine queries reflect true post-quantization norms and PQ centroid shrinkage.
 */
function computeReconstructedRowNorms(
  payload: VectorPayload,
  nextId: number,
  dim: number,
  presentMask: Uint8Array | null,
): Float32Array {
  const norms = new Float32Array(nextId)
  if (payload.kind === KIND_FLOAT32) {
    const vecs = payload.vectors
    for (let i = 0; i < nextId; i++) {
      if (presentMask !== null && !isMaskBitSet(presentMask, i)) continue
      const base = i * dim
      let n2 = 0
      for (let d = 0; d < dim; d++) {
        const v = vecs[base + d]
        n2 += v * v
      }
      norms[i] = Math.sqrt(n2)
    }
    return norms
  }

  if (payload.kind === KIND_INT8) {
    const { scales, codes } = payload
    for (let i = 0; i < nextId; i++) {
      if (presentMask !== null && !isMaskBitSet(presentMask, i)) continue
      const s = scales[i]
      if (s === 0) continue
      const base = i * dim
      let c2 = 0
      for (let d = 0; d < dim; d++) {
        const c = codes[base + d]
        c2 += c * c
      }
      norms[i] = s * Math.sqrt(c2)
    }
    return norms
  }

  const {
    subspaces: M,
    centroidsPerSubspace: K,
    subDim,
    centroids,
    codes,
  } = payload
  const centroidSq = new Float64Array(M * K)
  for (let m = 0; m < M; m++) {
    const cBase = m * K * subDim
    const sBase = m * K
    for (let k = 0; k < K; k++) {
      const kb = cBase + k * subDim
      let sq = 0
      for (let d = 0; d < subDim; d++) {
        const v = centroids[kb + d]
        sq += v * v
      }
      centroidSq[sBase + k] = sq
    }
  }
  for (let i = 0; i < nextId; i++) {
    if (presentMask !== null && !isMaskBitSet(presentMask, i)) continue
    const codeBase = i * M
    let sq = 0
    for (let m = 0; m < M; m++) {
      sq += centroidSq[m * K + codes[codeBase + m]]
    }
    norms[i] = Math.sqrt(sq)
  }
  return norms
}

function buildInvNorms(rowNorms: Float32Array | null): Float32Array | null {
  if (rowNorms === null) return null
  const inv = new Float32Array(rowNorms.length)
  for (let i = 0; i < rowNorms.length; i++) {
    const n = rowNorms[i]
    inv[i] = n > 1e-12 ? 1 / n : 0
  }
  return inv
}

function copyTypedBytes(
  src: Uint8Array,
  dst: Uint8Array,
  offset: number,
): number {
  dst.set(src, offset)
  return offset + src.byteLength
}

function safeProduct(values: readonly number[], label: string): number {
  let prod = 1
  for (const v of values) {
    prod *= v
    if (!Number.isSafeInteger(prod) || prod > MAX_PAYLOAD_BYTES) {
      throw new RangeError(
        `FrozenVectorIndex: ${label} byte length exceeds safe limit`,
      )
    }
  }
  return prod
}

function assertAllFiniteF32(arr: Float32Array, label: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw new RangeError(
        `FrozenVectorIndex: non-finite ${label} value at index ${i}`,
      )
    }
  }
}

function readOwnedFloat32Slice(
  bytes: Uint8Array,
  offset: number,
  count: number,
  label: string,
): { arr: Float32Array; nextOffset: number } {
  const byteLength = count * 4
  const slice = bytes.subarray(offset, offset + byteLength)
  const copy = new Uint8Array(byteLength)
  copy.set(slice)
  const arr = new Float32Array(copy.buffer)
  assertAllFiniteF32(arr, label)
  return { arr, nextOffset: offset + byteLength }
}

function prepareVectorIndexInit(
  binding: VectorCorpusBinding,
  work: Float32Array,
  dim: number,
  normalize: boolean,
  mask: Uint8Array | null,
  presentCount: number,
  options: VectorIndexOptions,
): {
  binding: VectorCorpusBinding
  fp: number
  dim: number
  metric: VectorMetric
  normalize: boolean
  mask: Uint8Array | null
  presentCount: number
  rowNorms: Float32Array | null
  payload: VectorPayload
  payloadBytes: number
} {
  const metric: VectorMetric = options.metric ?? 'cosine'
  assertMetric(metric)
  const nextId = binding.nextId
  const payload = buildPayloadFromFloat32(
    work,
    nextId,
    dim,
    mask,
    presentCount,
    options,
  )
  // Always compute exact post-quantization norms when cosine similarity is requested
  // so Int8 rounding or PQ centroid shrinkage cannot skew inter-query thresholds.
  const storeNorms =
    metric === 'cosine' && !(payload.kind === KIND_FLOAT32 && normalize)
  const rowNorms = storeNorms
    ? computeReconstructedRowNorms(payload, nextId, dim, mask)
    : null
  const fp = computeCorpusFingerprint(binding)
  const payloadBytes = computePayloadBytes(nextId, dim, mask, rowNorms, payload)
  return {
    binding,
    fp,
    dim,
    metric,
    normalize,
    mask,
    presentCount,
    rowNorms,
    payload,
    payloadBytes,
  }
}

/**
 * Auxiliary quantized or dense vector representation bound to a {@link FrozenMiniSearch} corpus.
 * Zero-dependency, Node + Browser compatible, and non-invasive to lexical indexing.
 */
export class FrozenVectorIndex<Id = unknown> {
  private readonly _binding: VectorCorpusBinding
  private readonly _corpusFingerprint: number
  private readonly _dim: number
  private readonly _metric: VectorMetric
  private readonly _normalized: boolean
  private readonly _presentMask: Uint8Array | null
  private readonly _presentCount: number
  private readonly _rowNorms: Float32Array | null
  private readonly _invRowNorms: Float32Array | null
  private readonly _payload: VectorPayload
  private readonly _payloadBytes: number

  private constructor(
    binding: VectorCorpusBinding,
    corpusFingerprint: number,
    dim: number,
    metric: VectorMetric,
    normalized: boolean,
    presentMask: Uint8Array | null,
    presentCount: number,
    rowNorms: Float32Array | null,
    payload: VectorPayload,
    payloadBytes: number,
  ) {
    this._binding = binding
    this._corpusFingerprint = corpusFingerprint
    this._dim = dim
    this._metric = metric
    this._normalized = normalized
    this._presentMask = presentMask
    this._presentCount = presentCount
    this._rowNorms = rowNorms
    this._invRowNorms = buildInvNorms(rowNorms)
    this._payload = payload
    this._payloadBytes = payloadBytes
  }

  private static fromWorkVectors<Id = unknown>(
    binding: VectorCorpusBinding,
    work: Float32Array,
    dim: number,
    normalize: boolean,
    mask: Uint8Array | null,
    presentCount: number,
    options: VectorIndexOptions,
  ): FrozenVectorIndex<Id> {
    const init = prepareVectorIndexInit(
      binding,
      work,
      dim,
      normalize,
      mask,
      presentCount,
      options,
    )
    return new FrozenVectorIndex<Id>(
      init.binding,
      init.fp,
      init.dim,
      init.metric,
      init.normalize,
      init.mask,
      init.presentCount,
      init.rowNorms,
      init.payload,
      init.payloadBytes,
    )
  }

  /** Build an auxiliary vector index from a `shortId`-aligned `Float32Array` of length `nextId * dim`. */
  static fromDenseFloat32<Id = unknown>(
    host: VectorCorpusHost,
    vectors: Float32Array,
    options: VectorIndexOptions,
  ): FrozenVectorIndex<Id> {
    if (!(vectors instanceof Float32Array)) {
      throw new TypeError(
        'FrozenVectorIndex: fromDenseFloat32 expects a Float32Array',
      )
    }
    assertDim(options.dim)
    const dim = options.dim
    const binding = readCorpusBinding(host)
    const nextId = binding.nextId
    const expectedLen = nextId * dim
    if (vectors.length !== expectedLen) {
      throw new RangeError(
        `FrozenVectorIndex: expected Float32Array length ${expectedLen} (nextId=${nextId} * dim=${dim}), got ${vectors.length}`,
      )
    }

    const normalize = options.normalize === true
    const hasHoles = binding.documentCount < nextId
    const mask = hasHoles ? new Uint8Array(presentMaskByteLength(nextId)) : null
    const work = new Float32Array(expectedLen)

    for (let shortId = 0; shortId < nextId; shortId++) {
      if (!isLiveShortId(binding, shortId)) continue
      if (mask !== null) setMaskBit(mask, shortId)
      const base = shortId * dim
      normalizeOrCopyRow(vectors, base, work, base, dim, normalize, shortId)
    }

    return FrozenVectorIndex.fromWorkVectors<Id>(
      binding,
      work,
      dim,
      normalize,
      mask,
      binding.documentCount,
      options,
    )
  }

  /** Build an auxiliary vector index from `{ id, vector }` or `[id, vector]` entries keyed by external document id. */
  static fromDocumentVectors<Id = unknown>(
    host: VectorCorpusHost,
    entries: Iterable<DocumentVectorEntry<Id>>,
    options: FromDocumentVectorsOptions,
  ): FrozenVectorIndex<Id> {
    assertDim(options.dim)
    const dim = options.dim
    const normalize = options.normalize === true
    const requireAll = options.requireAllLiveDocs !== false
    const binding = readCorpusBinding(host)
    const nextId = binding.nextId

    const seen = new Uint8Array(presentMaskByteLength(nextId))
    const work = new Float32Array(nextId * dim)
    let presentCount = 0

    for (const entry of entries) {
      if (entry == null || typeof entry !== 'object') {
        throw new TypeError('FrozenVectorIndex: invalid document vector entry')
      }
      let id: Id
      let vec: ArrayLike<number>
      if (Array.isArray(entry)) {
        id = entry[0] as Id
        vec = entry[1] as ArrayLike<number>
      } else {
        id = (entry as { id: Id }).id
        vec = (entry as { vector: ArrayLike<number> }).vector
      }

      const shortId = binding.lookup.get(id)
      if (shortId === undefined) {
        throw new RangeError(
          `FrozenVectorIndex: unknown document id ${String(id)}`,
        )
      }
      if (isMaskBitSet(seen, shortId)) {
        throw new RangeError(
          `FrozenVectorIndex: duplicate vector for document id ${String(id)}`,
        )
      }
      if (vec == null || vec.length !== dim) {
        throw new RangeError(
          `FrozenVectorIndex: vector length mismatch for document id ${String(id)} (expected ${dim}, got ${vec?.length})`,
        )
      }

      setMaskBit(seen, shortId)
      normalizeOrCopyRow(
        vec,
        0,
        work,
        shortId * dim,
        dim,
        normalize,
        String(id),
      )
      presentCount++
    }

    if (requireAll && presentCount !== binding.documentCount) {
      throw new RangeError(
        `FrozenVectorIndex: expected ${binding.documentCount} live document vectors, got ${presentCount}`,
      )
    }

    const useMask = presentCount < nextId ? seen : null
    return FrozenVectorIndex.fromWorkVectors<Id>(
      binding,
      work,
      dim,
      normalize,
      useMask,
      presentCount,
      options,
    )
  }

  /** Decode a binary `FXV1` vector pack and verify cryptographic integrity & corpus binding. */
  static loadBinary<Id = unknown>(
    input: unknown,
    host: VectorCorpusHost,
  ): FrozenVectorIndex<Id> {
    assertLittleEndianHost()
    const bytes = snapshotBytes(input)
    if (bytes.byteLength < VECTOR_HEADER_SIZE) {
      throw new RangeError('FrozenVectorIndex: binary buffer too short')
    }
    if (readAscii(bytes, 0, 4) !== VECTOR_MAGIC) {
      throw new Error('FrozenVectorIndex: invalid binary magic (expected FXV1)')
    }
    const version = readU16LE(bytes, 4)
    if (version !== VECTOR_VERSION) {
      throw new Error(`FrozenVectorIndex: unsupported version ${version}`)
    }
    const storedHeaderCrc = readU32LE(bytes, 36)
    const computedHeaderCrc = crc32Update(0, bytes, 0, 36) >>> 0
    if (storedHeaderCrc !== computedHeaderCrc) {
      throw new Error('FrozenVectorIndex: header CRC-32 mismatch')
    }

    const kind = readU8(bytes, 6)
    if (kind !== KIND_FLOAT32 && kind !== KIND_INT8 && kind !== KIND_PQ_U8) {
      throw new Error(`FrozenVectorIndex: unknown quantization kind ${kind}`)
    }
    const flags = readU8(bytes, 7)
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      throw new Error(
        `FrozenVectorIndex: unsupported flags 0x${flags.toString(16)}`,
      )
    }
    const normalized = (flags & FLAG_NORMALIZED) !== 0
    const hasMask = (flags & FLAG_HAS_PRESENT_MASK) !== 0
    const hasRowNorms = (flags & FLAG_HAS_ROW_NORMS) !== 0
    const metric: VectorMetric =
      (flags & FLAG_METRIC_COSINE) !== 0 ? 'cosine' : 'dot'

    const dim = readU32LE(bytes, 8)
    assertDim(dim)
    const nextId = readU32LE(bytes, 12)
    const documentCount = readU32LE(bytes, 16)
    if (documentCount > nextId) {
      throw new Error(
        `FrozenVectorIndex: corrupt counts (documentCount=${documentCount} > nextId=${nextId})`,
      )
    }
    const corpusFingerprint = readU32LE(bytes, 20)
    const pqSubspaces = readU16LE(bytes, 24)
    const pqCentroids = readU16LE(bytes, 26)
    const payloadByteLength = readU32LE(bytes, 28)
    const storedPayloadCrc = readU32LE(bytes, 32)

    if (bytes.byteLength - VECTOR_HEADER_SIZE !== payloadByteLength) {
      throw new RangeError(
        `FrozenVectorIndex: byte length mismatch (expected ${VECTOR_HEADER_SIZE + payloadByteLength}, got ${bytes.byteLength})`,
      )
    }
    const computedPayloadCrc =
      crc32Update(0, bytes, VECTOR_HEADER_SIZE, bytes.byteLength) >>> 0
    if (storedPayloadCrc !== computedPayloadCrc) {
      throw new Error('FrozenVectorIndex: payload CRC-32 mismatch')
    }

    const maskBytesLen = hasMask ? presentMaskByteLength(nextId) : 0
    const normBytesLen = hasRowNorms ? safeProduct([nextId, 4], 'row norms') : 0
    let dataBytesLen = 0
    if (kind === KIND_FLOAT32) {
      if (pqSubspaces !== 0 || pqCentroids !== 0) {
        throw new Error('FrozenVectorIndex: non-zero PQ fields on float32 pack')
      }
      dataBytesLen = safeProduct([nextId, dim, 4], 'float32 payload')
    } else if (kind === KIND_INT8) {
      if (pqSubspaces !== 0 || pqCentroids !== 0) {
        throw new Error('FrozenVectorIndex: non-zero PQ fields on int8 pack')
      }
      const scalesLen = safeProduct([nextId, 4], 'int8 scales')
      const codesLen = safeProduct([nextId, dim], 'int8 codes')
      dataBytesLen = scalesLen + codesLen
    } else {
      if (pqSubspaces < 1 || dim % pqSubspaces !== 0) {
        throw new Error('FrozenVectorIndex: invalid PQ subspace configuration')
      }
      if (pqCentroids < 1 || pqCentroids > 256) {
        throw new Error('FrozenVectorIndex: invalid PQ centroid count')
      }
      const subDim = dim / pqSubspaces
      const centroidLen = safeProduct(
        [pqSubspaces, pqCentroids, subDim, 4],
        'pq centroids',
      )
      const codesLen = safeProduct([nextId, pqSubspaces], 'pq codes')
      dataBytesLen = centroidLen + codesLen
    }

    if (maskBytesLen + normBytesLen + dataBytesLen !== payloadByteLength) {
      throw new RangeError(
        `FrozenVectorIndex: payload size mismatch (expected ${maskBytesLen + normBytesLen + dataBytesLen}, got ${payloadByteLength})`,
      )
    }

    const binding = readCorpusBinding(host)
    if (binding.documentCount !== documentCount || binding.nextId !== nextId) {
      throw new Error(
        `FrozenVectorIndex: corpus shape mismatch (pack documentCount=${documentCount}, nextId=${nextId}; host documentCount=${binding.documentCount}, nextId=${binding.nextId})`,
      )
    }
    const hostFp = computeCorpusFingerprint(binding)
    if (hostFp !== corpusFingerprint) {
      throw new Error(
        `FrozenVectorIndex: corpus fingerprint mismatch (pack=0x${corpusFingerprint.toString(16)}, host=0x${hostFp.toString(16)})`,
      )
    }

    let cursor = VECTOR_HEADER_SIZE
    let presentMask: Uint8Array | null = null
    let presentCount = documentCount
    if (hasMask) {
      presentMask = new Uint8Array(maskBytesLen)
      presentMask.set(bytes.subarray(cursor, cursor + maskBytesLen))
      cursor += maskBytesLen
      for (let i = 0; i < nextId; i++) {
        if (!isLiveShortId(binding, i) && isMaskBitSet(presentMask, i)) {
          throw new Error(
            `FrozenVectorIndex: present mask marks dead document slot ${i}`,
          )
        }
      }
      presentCount = countMaskBits(presentMask, nextId)
      if (presentCount > documentCount) {
        throw new Error('FrozenVectorIndex: presentCount exceeds documentCount')
      }
    } else if (documentCount < nextId) {
      throw new Error(
        'FrozenVectorIndex: corpus contains deleted slots but pack omits presentMask',
      )
    }

    let rowNorms: Float32Array | null = null
    if (hasRowNorms) {
      const normRes = readOwnedFloat32Slice(bytes, cursor, nextId, 'row norm')
      for (let i = 0; i < normRes.arr.length; i++) {
        if (normRes.arr[i] < 0) {
          throw new RangeError(
            `FrozenVectorIndex: negative row norm at index ${i}`,
          )
        }
      }
      rowNorms = normRes.arr
      cursor = normRes.nextOffset
    }

    let payload: VectorPayload
    if (kind === KIND_FLOAT32) {
      const res = readOwnedFloat32Slice(
        bytes,
        cursor,
        nextId * dim,
        'float32 vector',
      )
      payload = { kind: KIND_FLOAT32, vectors: res.arr }
    } else if (kind === KIND_INT8) {
      const scalesRes = readOwnedFloat32Slice(
        bytes,
        cursor,
        nextId,
        'int8 scale',
      )
      for (let i = 0; i < scalesRes.arr.length; i++) {
        if (scalesRes.arr[i] < 0) {
          throw new RangeError(
            `FrozenVectorIndex: negative int8 scale at index ${i}`,
          )
        }
      }
      cursor = scalesRes.nextOffset
      const codeLen = nextId * dim
      const codeBytes = new Int8Array(codeLen)
      codeBytes.set(
        new Int8Array(bytes.buffer, bytes.byteOffset + cursor, codeLen),
      )
      payload = { kind: KIND_INT8, scales: scalesRes.arr, codes: codeBytes }
    } else {
      const subDim = dim / pqSubspaces
      const centroidCount = pqSubspaces * pqCentroids * subDim
      const cenRes = readOwnedFloat32Slice(
        bytes,
        cursor,
        centroidCount,
        'pq centroid',
      )
      cursor = cenRes.nextOffset
      const codeLen = nextId * pqSubspaces
      const codeBytes = new Uint8Array(codeLen)
      codeBytes.set(bytes.subarray(cursor, cursor + codeLen))
      if (pqCentroids < 256) {
        for (let i = 0; i < codeLen; i++) {
          if (codeBytes[i] >= pqCentroids) {
            throw new RangeError(
              `FrozenVectorIndex: PQ code ${codeBytes[i]} exceeds centroid count ${pqCentroids}`,
            )
          }
        }
      }
      payload = {
        kind: KIND_PQ_U8,
        subspaces: pqSubspaces,
        centroidsPerSubspace: pqCentroids,
        subDim,
        centroids: cenRes.arr,
        codes: codeBytes,
      }
    }

    return new FrozenVectorIndex<Id>(
      binding,
      corpusFingerprint,
      dim,
      metric,
      normalized,
      presentMask,
      presentCount,
      rowNorms,
      payload,
      payloadByteLength,
    )
  }

  /** Compute deterministic unsigned CRC-32 corpus identity fingerprint for a {@link FrozenMiniSearch} instance. */
  static corpusFingerprint(host: VectorCorpusHost): number {
    return computeCorpusFingerprint(readCorpusBinding(host))
  }

  get quantization(): VectorQuantization {
    if (this._payload.kind === KIND_FLOAT32) return 'float32'
    if (this._payload.kind === KIND_INT8) return 'int8'
    return 'pq'
  }

  get metric(): VectorMetric {
    return this._metric
  }

  get dim(): number {
    return this._dim
  }

  get documentCount(): number {
    return this._binding.documentCount
  }

  get nextId(): number {
    return this._binding.nextId
  }

  get corpusFingerprint(): number {
    return this._corpusFingerprint
  }

  get presentCount(): number {
    return this._presentCount
  }

  get pqSubspaces(): number {
    return this._payload.kind === KIND_PQ_U8 ? this._payload.subspaces : 0
  }

  get pqCentroidsPerSubspace(): number {
    return this._payload.kind === KIND_PQ_U8
      ? this._payload.centroidsPerSubspace
      : 0
  }

  get normalized(): boolean {
    return this._normalized
  }

  get hasReconstructedNorms(): boolean {
    return this._rowNorms !== null
  }

  /** Serialized wire byte length (header + payload). */
  get byteLength(): number {
    return VECTOR_HEADER_SIZE + this._payloadBytes
  }

  stats(): FrozenVectorIndexStats {
    return {
      quantization: this.quantization,
      metric: this._metric,
      dim: this._dim,
      documentCount: this.documentCount,
      nextId: this.nextId,
      corpusFingerprint: this._corpusFingerprint,
      presentCount: this._presentCount,
      pqSubspaces: this.pqSubspaces,
      pqCentroidsPerSubspace: this.pqCentroidsPerSubspace,
      normalized: this._normalized,
      hasReconstructedNorms: this._rowNorms !== null,
      byteLength: this.byteLength,
    }
  }

  /** Return `true` when `id` exists on the bound corpus and has a vector row. */
  hasVector(id: Id): boolean {
    const shortId = this._binding.lookup.get(id)
    if (shortId === undefined) return false
    return (
      this._presentMask === null || isMaskBitSet(this._presentMask, shortId)
    )
  }

  /** Assert that another {@link FrozenMiniSearch} instance has identical corpus identity. */
  assertCompatibleWith(host: VectorCorpusHost): void {
    const other = readCorpusBinding(host)
    if (
      other.documentCount !== this._binding.documentCount ||
      other.nextId !== this._binding.nextId
    ) {
      throw new Error(
        `FrozenVectorIndex: corpus shape mismatch (vector documentCount=${this._binding.documentCount}, nextId=${this._binding.nextId}; host documentCount=${other.documentCount}, nextId=${other.nextId})`,
      )
    }
    const otherFp = computeCorpusFingerprint(other)
    if (otherFp !== this._corpusFingerprint) {
      throw new Error(
        `FrozenVectorIndex: corpus fingerprint mismatch (vector=0x${this._corpusFingerprint.toString(16)}, host=0x${otherFp.toString(16)})`,
      )
    }
  }

  /** Serialize this vector index to portable little-endian `FXV1` bytes (Node + Browser). */
  saveBinary(): Uint8Array {
    assertLittleEndianHost()
    const totalBytes = VECTOR_HEADER_SIZE + this._payloadBytes
    const out = new Uint8Array(totalBytes)
    const flags =
      (this._normalized ? FLAG_NORMALIZED : 0) |
      (this._presentMask !== null ? FLAG_HAS_PRESENT_MASK : 0) |
      (this._rowNorms !== null ? FLAG_HAS_ROW_NORMS : 0) |
      (this._metric === 'cosine' ? FLAG_METRIC_COSINE : 0)

    writeAscii(out, 0, VECTOR_MAGIC)
    writeU16LE(out, 4, VECTOR_VERSION)
    writeU8(out, 6, this._payload.kind)
    writeU8(out, 7, flags)
    writeU32LE(out, 8, this._dim)
    writeU32LE(out, 12, this._binding.nextId)
    writeU32LE(out, 16, this._binding.documentCount)
    writeU32LE(out, 20, this._corpusFingerprint)
    writeU16LE(out, 24, this.pqSubspaces)
    writeU16LE(out, 26, this.pqCentroidsPerSubspace)
    writeU32LE(out, 28, this._payloadBytes)

    let offset = VECTOR_HEADER_SIZE
    if (this._presentMask !== null) {
      offset = copyTypedBytes(this._presentMask, out, offset)
    }
    if (this._rowNorms !== null) {
      const rn = this._rowNorms
      offset = copyTypedBytes(
        new Uint8Array(rn.buffer, rn.byteOffset, rn.byteLength),
        out,
        offset,
      )
    }
    if (this._payload.kind === KIND_FLOAT32) {
      const v = this._payload.vectors
      offset = copyTypedBytes(
        new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
        out,
        offset,
      )
    } else if (this._payload.kind === KIND_INT8) {
      const s = this._payload.scales
      const c = this._payload.codes
      offset = copyTypedBytes(
        new Uint8Array(s.buffer, s.byteOffset, s.byteLength),
        out,
        offset,
      )
      copyTypedBytes(
        new Uint8Array(c.buffer, c.byteOffset, c.byteLength),
        out,
        offset,
      )
    } else {
      const cen = this._payload.centroids
      const c = this._payload.codes
      offset = copyTypedBytes(
        new Uint8Array(cen.buffer, cen.byteOffset, cen.byteLength),
        out,
        offset,
      )
      copyTypedBytes(
        new Uint8Array(c.buffer, c.byteOffset, c.byteLength),
        out,
        offset,
      )
    }

    const payloadCrc = crc32Update(0, out, VECTOR_HEADER_SIZE, out.length) >>> 0
    writeU32LE(out, 32, payloadCrc)
    const headerCrc = crc32Update(0, out, 0, 36) >>> 0
    writeU32LE(out, 36, headerCrc)
    return out
  }

  private resolveQueryMetric(requested?: VectorMetric): VectorMetric {
    const metric = requested ?? this._metric
    assertMetric(metric)
    if (
      metric === 'cosine' &&
      this._invRowNorms === null &&
      !(this._payload.kind === KIND_FLOAT32 && this._normalized)
    ) {
      throw new Error(
        'FrozenVectorIndex: cannot compute cosine on a dot-only vector index without reconstructed norms',
      )
    }
    return metric
  }

  /** Score a single document by external ID (`undefined` if unknown or missing vector). */
  scoreDocument(
    queryVector: ArrayLike<number>,
    id: Id,
    options?: { metric?: VectorMetric },
  ): number | undefined {
    const metric = this.resolveQueryMetric(options?.metric)
    const shortId = this._binding.lookup.get(id)
    if (shortId === undefined) return undefined
    if (
      this._presentMask !== null &&
      !isMaskBitSet(this._presentMask, shortId)
    ) {
      return undefined
    }
    const { vec: q, isZero } = prepareQueryVector(
      queryVector,
      this._dim,
      metric === 'cosine',
    )
    if (isZero) return 0
    let score: number
    if (this._payload.kind === KIND_FLOAT32) {
      score = dotFloat32Row(
        q,
        this._payload.vectors,
        shortId * this._dim,
        this._dim,
      )
    } else if (this._payload.kind === KIND_INT8) {
      score =
        dotInt8Row(q, this._payload.codes, shortId * this._dim, this._dim) *
        this._payload.scales[shortId]
    } else {
      const lut = buildPqLut(q, this._payload)
      score = scorePqRow(
        lut,
        this._payload.codes,
        shortId * this._payload.subspaces,
        this._payload.subspaces,
        this._payload.centroidsPerSubspace,
      )
    }
    if (metric === 'cosine' && this._invRowNorms !== null) {
      score *= this._invRowNorms[shortId]
    }
    return score
  }

  /** Find top-`k` documents matching `queryVector` with optional `minScore`, `metric`, and pre-`k` predicate `filter`. */
  topK(
    queryVector: ArrayLike<number>,
    options: VectorSearchOptions<Id> = {},
  ): VectorSearchHit<Id>[] {
    const k = options.k ?? 10
    if (!Number.isInteger(k) || k < 0) {
      throw new RangeError(
        'FrozenVectorIndex: k must be a non-negative integer',
      )
    }
    const minScore = options.minScore ?? -Infinity
    if (Number.isNaN(minScore)) {
      throw new RangeError('FrozenVectorIndex: minScore must not be NaN')
    }
    const filter = options.filter
    if (filter !== undefined && typeof filter !== 'function') {
      throw new TypeError('FrozenVectorIndex: filter must be a function')
    }
    const metric = this.resolveQueryMetric(options.metric)
    const { vec: q, isZero } = prepareQueryVector(
      queryVector,
      this._dim,
      metric === 'cosine',
    )
    if (k === 0 || this._presentCount === 0) return []
    if (isZero && minScore > 0) return []

    const nextId = this._binding.nextId
    const dim = this._dim
    const mask = this._presentMask
    const invNorms = metric === 'cosine' ? this._invRowNorms : null
    const binding = this._binding
    const capK = Math.min(k, this._presentCount)

    const heapIds = new Int32Array(capK)
    const heapScores = new Float64Array(capK)
    let heapSize = 0

    const pushHeap = (shortId: number, score: number): void => {
      if (heapSize < capK) {
        heapIds[heapSize] = shortId
        heapScores[heapSize] = score
        siftUp(heapIds, heapScores, heapSize)
        heapSize++
      } else if (isBetterHit(shortId, score, heapIds[0], heapScores[0])) {
        heapIds[0] = shortId
        heapScores[0] = score
        siftDown(heapIds, heapScores, capK)
      }
    }

    const payload = this._payload
    if (payload.kind === KIND_FLOAT32) {
      const vecs = payload.vectors
      for (let shortId = 0; shortId < nextId; shortId++) {
        if (mask !== null && !isMaskBitSet(mask, shortId)) continue
        if (
          filter !== undefined &&
          !filter(resolveExternalId(binding, shortId) as Id, shortId)
        ) {
          continue
        }
        let score = isZero ? 0 : dotFloat32Row(q, vecs, shortId * dim, dim)
        if (invNorms !== null) score *= invNorms[shortId]
        if (!(score >= minScore)) continue
        pushHeap(shortId, score)
      }
    } else if (payload.kind === KIND_INT8) {
      const scales = payload.scales
      const codes = payload.codes
      for (let shortId = 0; shortId < nextId; shortId++) {
        if (mask !== null && !isMaskBitSet(mask, shortId)) continue
        if (
          filter !== undefined &&
          !filter(resolveExternalId(binding, shortId) as Id, shortId)
        ) {
          continue
        }
        let score = isZero
          ? 0
          : dotInt8Row(q, codes, shortId * dim, dim) * scales[shortId]
        if (invNorms !== null) score *= invNorms[shortId]
        if (!(score >= minScore)) continue
        pushHeap(shortId, score)
      }
    } else {
      const lut = isZero ? null : buildPqLut(q, payload)
      const M = payload.subspaces
      const K = payload.centroidsPerSubspace
      const codes = payload.codes
      for (let shortId = 0; shortId < nextId; shortId++) {
        if (mask !== null && !isMaskBitSet(mask, shortId)) continue
        if (
          filter !== undefined &&
          !filter(resolveExternalId(binding, shortId) as Id, shortId)
        ) {
          continue
        }
        let score = lut !== null ? scorePqRow(lut, codes, shortId * M, M, K) : 0
        if (invNorms !== null) score *= invNorms[shortId]
        if (!(score >= minScore)) continue
        pushHeap(shortId, score)
      }
    }

    const results: VectorSearchHit<Id>[] = new Array(heapSize)
    for (let i = 0; i < heapSize; i++) {
      const shortId = heapIds[i]
      results[i] = {
        id: resolveExternalId(binding, shortId) as Id,
        shortId,
        score: heapScores[i],
      }
    }
    results.sort((a, b) => b.score - a.score || a.shortId - b.shortId)
    return results
  }
}

function computePayloadBytes(
  nextId: number,
  dim: number,
  mask: Uint8Array | null,
  rowNorms: Float32Array | null,
  payload: VectorPayload,
): number {
  const maskBytes = mask !== null ? mask.byteLength : 0
  const normBytes = rowNorms !== null ? rowNorms.byteLength : 0
  if (payload.kind === KIND_FLOAT32) {
    return maskBytes + normBytes + nextId * dim * 4
  }
  if (payload.kind === KIND_INT8) {
    return maskBytes + normBytes + nextId * 4 + nextId * dim
  }
  return (
    maskBytes +
    normBytes +
    payload.centroids.byteLength +
    payload.codes.byteLength
  )
}

function prepareQueryVector(
  queryVector: ArrayLike<number>,
  dim: number,
  normalize: boolean,
): { vec: Float32Array; isZero: boolean } {
  if (queryVector == null || queryVector.length !== dim) {
    throw new RangeError(
      `FrozenVectorIndex: queryVector length must be ${dim}, got ${queryVector?.length}`,
    )
  }
  const q = new Float32Array(dim)
  let norm2 = 0
  for (let d = 0; d < dim; d++) {
    const val = queryVector[d]
    if (!Number.isFinite(val)) {
      throw new RangeError(
        `FrozenVectorIndex: non-finite queryVector value at dim ${d}`,
      )
    }
    q[d] = val
    norm2 += val * val
  }
  if (norm2 <= 1e-24) {
    return { vec: q, isZero: true }
  }
  if (normalize) {
    const inv = 1 / Math.sqrt(norm2)
    for (let d = 0; d < dim; d++) q[d] *= inv
  }
  return { vec: q, isZero: false }
}

function dotFloat32Row(
  q: Float32Array,
  vecs: Float32Array,
  base: number,
  dim: number,
): number {
  let dot = 0
  for (let d = 0; d < dim; d++) {
    dot += q[d] * vecs[base + d]
  }
  return dot
}

function dotInt8Row(
  q: Float32Array,
  codes: Int8Array,
  base: number,
  dim: number,
): number {
  let dot = 0
  for (let d = 0; d < dim; d++) {
    dot += q[d] * codes[base + d]
  }
  return dot
}

function buildPqLut(
  q: Float32Array,
  payload: Extract<VectorPayload, { kind: typeof KIND_PQ_U8 }>,
): Float32Array {
  const { subspaces: M, centroidsPerSubspace: K, subDim, centroids } = payload
  const lut = new Float32Array(M * K)
  for (let m = 0; m < M; m++) {
    const qBase = m * subDim
    const cBase = m * K * subDim
    const lBase = m * K
    for (let c = 0; c < K; c++) {
      const cb = cBase + c * subDim
      let dot = 0
      for (let d = 0; d < subDim; d++) {
        dot += q[qBase + d] * centroids[cb + d]
      }
      lut[lBase + c] = dot
    }
  }
  return lut
}

function scorePqRow(
  lut: Float32Array,
  codes: Uint8Array,
  codeBase: number,
  M: number,
  K: number,
): number {
  let sum = 0
  for (let m = 0; m < M; m++) {
    sum += lut[m * K + codes[codeBase + m]]
  }
  return sum
}

/** True when hit A outranks hit B (higher score, or lower shortId on tie). */
function isBetterHit(
  idA: number,
  scoreA: number,
  idB: number,
  scoreB: number,
): boolean {
  return scoreA > scoreB || (scoreA === scoreB && idA < idB)
}

function siftUp(
  heapIds: Int32Array,
  heapScores: Float64Array,
  idx: number,
): void {
  const id = heapIds[idx]
  const score = heapScores[idx]
  while (idx > 0) {
    const parent = (idx - 1) >>> 1
    if (!isBetterHit(heapIds[parent], heapScores[parent], id, score)) break
    heapIds[idx] = heapIds[parent]
    heapScores[idx] = heapScores[parent]
    idx = parent
  }
  heapIds[idx] = id
  heapScores[idx] = score
}

function siftDown(
  heapIds: Int32Array,
  heapScores: Float64Array,
  size: number,
): void {
  let idx = 0
  const id = heapIds[0]
  const score = heapScores[0]
  const half = size >>> 1
  while (idx < half) {
    let child = (idx << 1) + 1
    const right = child + 1
    if (
      right < size &&
      isBetterHit(
        heapIds[child],
        heapScores[child],
        heapIds[right],
        heapScores[right],
      )
    ) {
      child = right
    }
    if (!isBetterHit(id, score, heapIds[child], heapScores[child])) break
    heapIds[idx] = heapIds[child]
    heapScores[idx] = heapScores[child]
    idx = child
  }
  heapIds[idx] = id
  heapScores[idx] = score
}
