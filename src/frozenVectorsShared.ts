import {
  assertLittleEndianHost,
  readAscii,
  readU16LE,
  readU32LE,
  readU8,
  readUtf8,
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

export const VECTOR_MAGIC = 'FXV1'
export const VECTOR_VERSION = 2
export const VECTOR_HEADER_SIZE = 40

export const KIND_FLOAT32 = 1
export const KIND_INT8 = 2
export const KIND_PQ_U8 = 3

export const FLAG_NORMALIZED = 1 << 0
export const FLAG_HAS_PRESENT_MASK = 1 << 1
export const FLAG_HAS_ROW_NORMS = 1 << 2
export const FLAG_METRIC_COSINE = 1 << 3
export const KNOWN_FLAGS =
  FLAG_NORMALIZED |
  FLAG_HAS_PRESENT_MASK |
  FLAG_HAS_ROW_NORMS |
  FLAG_METRIC_COSINE

export const MAX_DIM = 65536
export const MAX_PAYLOAD_BYTES = 0x7fffffff
export const MAX_METADATA_BYTES = 65535

const FP_TAG_HOLE = 0
const FP_TAG_STRING = 1
const FP_TAG_NUMBER = 2

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
  /**
   * Consumer-supplied representation / model / preprocessing / vector-space version identifier
   * (e.g. `'tfidf-svd128-norm:v1'`). Persisted in the binary pack and verified on load/attach.
   */
  representationVersion: string
  /**
   * Consumer-supplied content / ordering snapshot identifier binding the corpus documents,
   * entity ordering behind shortIds, and preprocessing (e.g. `'sha256:...'`).
   * Persisted in the binary pack and verified on load/attach.
   */
  snapshotId: string
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
  /** Strict sample cap per PQ subspace (`quantization: 'pq'`). Defaults to `4096`. */
  pqSampleSize?: number
}

export type DocumentVectorEntry<Id = unknown> =
  { id: Id; vector: ArrayLike<number> } | readonly [Id, ArrayLike<number>]

export interface FromDocumentVectorsOptions extends VectorIndexOptions {
  /** Reject missing vectors for any live document in the corpus. Defaults to `true`. */
  requireAllLiveDocs?: boolean
}

/** Expected representation and corpus snapshot metadata verified on binary load and host attach. */
export interface VectorExpectation {
  representationVersion: string
  snapshotId: string
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
  /**
   * Structural ID/slot mapping CRC-32 fingerprint only (`documentCount`, `nextId`,
   * holes, and typed `string | number` external IDs). Does not inspect document text
   * or entity order behind dense `0..N-1` integer IDs; use {@link snapshotId} for that.
   */
  corpusFingerprint: number
  mappingFingerprint: number
  representationVersion: string
  snapshotId: string
  presentCount: number
  pqSubspaces: number
  pqCentroidsPerSubspace: number
  normalized: boolean
  hasReconstructedNorms: boolean
  byteLength: number
}

export type VectorPayload =
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

export function assertNonNegInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `FrozenVectorIndex: ${label} must be a non-negative integer`,
    )
  }
}

export function assertDim(dim: number): void {
  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) {
    throw new RangeError(
      `FrozenVectorIndex: dim must be an integer in [1, ${MAX_DIM}]`,
    )
  }
}

export function assertMetric(metric: VectorMetric): void {
  if (metric !== 'cosine' && metric !== 'dot') {
    throw new TypeError(
      `FrozenVectorIndex: unsupported metric "${String(metric)}"`,
    )
  }
}

export function assertMetadataString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `FrozenVectorIndex: ${label} must be a non-empty string`,
    )
  }
  const encoded = utf8Bytes(value)
  if (encoded.byteLength > MAX_METADATA_BYTES) {
    throw new RangeError(
      `FrozenVectorIndex: ${label} UTF-8 byte length exceeds ${MAX_METADATA_BYTES}`,
    )
  }
  return value
}

export function readExpectation(expected: unknown): VectorExpectation {
  if (expected == null || typeof expected !== 'object') {
    throw new TypeError(
      'FrozenVectorIndex: expected metadata object { representationVersion, snapshotId } is required',
    )
  }
  const exp = expected as Partial<VectorExpectation>
  return {
    representationVersion: assertMetadataString(
      exp.representationVersion,
      'expected.representationVersion',
    ),
    snapshotId: assertMetadataString(exp.snapshotId, 'expected.snapshotId'),
  }
}

export function readCorpusBinding(host: unknown): VectorCorpusBinding {
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
      'FrozenVectorIndex: invalid documentCount exceeds nextId on host corpus',
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

export function resolveExternalId(
  binding: VectorCorpusBinding,
  shortId: number,
): unknown {
  return binding.externalIds === null ? shortId : binding.externalIds[shortId]
}

export function isLiveShortId(
  binding: VectorCorpusBinding,
  shortId: number,
): boolean {
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
  U32_SCRATCH[0] = tag
  writeU32At(U32_SCRATCH, 1, shortId)
  return crc32Update(seed, U32_SCRATCH, 0, 5)
}

/**
 * Compute structural slot + external-ID mapping CRC-32 fingerprint.
 * Persistence policy: only `string` and finite `number` external IDs are accepted
 * (plain objects, arrays, booleans, symbols, NaN, and Infinity are explicitly rejected
 * rather than collapsed through `String()`).
 */
export function computeMappingFingerprint(
  binding: VectorCorpusBinding,
): number {
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
    } else if (typeof ext === 'number' && Number.isFinite(ext)) {
      seed = hashTagShortId(seed, FP_TAG_NUMBER, shortId)
      FLOAT_SCRATCH_VIEW.setFloat64(0, ext, true)
      seed = crc32Update(seed, FLOAT_SCRATCH_BYTES, 0, 8)
    } else {
      throw new TypeError(
        `FrozenVectorIndex: unsupported external document ID type at shortId ${shortId} (expected string or finite number)`,
      )
    }
  }
  return seed >>> 0
}

export function presentMaskByteLength(nextId: number): number {
  return (nextId + 7) >>> 3
}

export function isMaskBitSet(mask: Uint8Array, index: number): boolean {
  return (mask[index >>> 3] & (1 << (index & 7))) !== 0
}

export function setMaskBit(mask: Uint8Array, index: number): void {
  mask[index >>> 3] |= 1 << (index & 7)
}

export function countMaskBits(mask: Uint8Array, nextId: number): number {
  let count = 0
  for (let i = 0; i < nextId; i++) {
    if (isMaskBitSet(mask, i)) count++
  }
  return count
}

export function resolvePqSubspaces(dim: number, requested?: number): number {
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
  for (const cand of [32, 16, 8, 4, 2, 1]) {
    if (cand <= dim && dim % cand === 0) return cand
  }
  return 1
}

/**
 * Copy and optionally L2-normalize one vector into Float32 without overflowing or
 * underflowing JS float64 during norm computation or float32 narrowing prior to scaling.
 */
export function readAndNormalizeVector(
  src: ArrayLike<number>,
  srcOffset: number,
  dst: Float32Array,
  dstOffset: number,
  dim: number,
  normalize: boolean,
  label: string | number,
): boolean {
  let maxAbs = 0
  for (let d = 0; d < dim; d++) {
    const val = src[srcOffset + d]
    if (!Number.isFinite(val)) {
      throw new RangeError(
        `FrozenVectorIndex: non-finite value at ${label}, dim ${d}`,
      )
    }
    const absVal = Math.abs(val)
    if (absVal > maxAbs) maxAbs = absVal
  }
  if (maxAbs === 0) {
    dst.fill(0, dstOffset, dstOffset + dim)
    return true
  }
  if (!normalize) {
    for (let d = 0; d < dim; d++) {
      const f = Math.fround(src[srcOffset + d])
      if (!Number.isFinite(f)) {
        throw new RangeError(
          `FrozenVectorIndex: float32 overflow at ${label}, dim ${d}`,
        )
      }
      dst[dstOffset + d] = f
    }
    return false
  }
  let scaledNorm2 = 0
  for (let d = 0; d < dim; d++) {
    const s = src[srcOffset + d] / maxAbs
    scaledNorm2 += s * s
  }
  const invNorm = 1 / Math.sqrt(scaledNorm2)
  for (let d = 0; d < dim; d++) {
    const scaled = (src[srcOffset + d] / maxAbs) * invNorm
    dst[dstOffset + d] = scaled
  }
  return false
}

export function buildInt8Payload(
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
    const scale = Math.fround(maxAbs / 127)
    if (maxAbs === 0 || scale === 0 || !Number.isFinite(scale)) {
      scales[i] = 0
      continue
    }
    scales[i] = scale
    const inv = 1 / scale
    for (let d = 0; d < dim; d++) {
      const q = Math.round(vectors[base + d] * inv)
      codes[base + d] = q > 127 ? 127 : q < -127 ? -127 : q
    }
  }
  return { kind: KIND_INT8, scales, codes }
}

function safeFloat32NormFromRow(
  arr: Float32Array,
  base: number,
  len: number,
  label: string,
): number {
  let maxAbs = 0
  for (let d = 0; d < len; d++) {
    const a = Math.abs(arr[base + d])
    if (a > maxAbs) maxAbs = a
  }
  if (maxAbs === 0) return 0
  let scaledSq = 0
  for (let d = 0; d < len; d++) {
    const s = arr[base + d] / maxAbs
    scaledSq += s * s
  }
  const norm = maxAbs * Math.sqrt(scaledSq)
  if (!Number.isFinite(norm) || !Number.isFinite(Math.fround(norm))) {
    throw new RangeError(
      `FrozenVectorIndex: reconstructed ${label} norm overflows float32`,
    )
  }
  return norm
}

/**
 * Compute exact L2 norms of the reconstructed vectors (NOT pre-rounding input norms)
 * so cosine queries reflect true post-quantization norms and PQ centroid shrinkage.
 */
export function computeReconstructedRowNorms(
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
      norms[i] = safeFloat32NormFromRow(vecs, i * dim, dim, `row ${i}`)
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
      const norm = s * Math.sqrt(c2)
      if (!Number.isFinite(norm) || !Number.isFinite(Math.fround(norm))) {
        throw new RangeError(
          `FrozenVectorIndex: reconstructed int8 row norm overflows float32 at ${i}`,
        )
      }
      norms[i] = norm
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
    const norm = Math.sqrt(sq)
    if (!Number.isFinite(norm) || !Number.isFinite(Math.fround(norm))) {
      throw new RangeError(
        `FrozenVectorIndex: reconstructed PQ row norm overflows float32 at ${i}`,
      )
    }
    norms[i] = norm
  }
  return norms
}

export function copyTypedBytes(
  src: Uint8Array,
  dst: Uint8Array,
  offset: number,
): number {
  dst.set(src, offset)
  return offset + src.byteLength
}

export function safeProduct(values: readonly number[], label: string): number {
  let acc = 1
  for (const v of values) {
    acc *= v
    if (!Number.isSafeInteger(acc) || acc > MAX_PAYLOAD_BYTES) {
      throw new RangeError(
        `FrozenVectorIndex: ${label} byte length exceeds safe limit`,
      )
    }
  }
  return acc
}

export function assertAllFiniteF32(arr: Float32Array, label: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw new RangeError(
        `FrozenVectorIndex: non-finite ${label} value at index ${i}`,
      )
    }
  }
}

export function readOwnedFloat32Slice(
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

export function computeDataByteLength(payload: VectorPayload): number {
  if (payload.kind === KIND_FLOAT32) return payload.vectors.byteLength
  if (payload.kind === KIND_INT8) {
    return payload.scales.byteLength + payload.codes.byteLength
  }
  return payload.centroids.byteLength + payload.codes.byteLength
}

export function computeMetadataByteLength(
  representationVersion: string,
  snapshotId: string,
): number {
  return (
    4 +
    utf8Bytes(representationVersion).byteLength +
    utf8Bytes(snapshotId).byteLength
  )
}

export function computePayloadBytes(
  mask: Uint8Array | null,
  rowNorms: Float32Array | null,
  payload: VectorPayload,
  representationVersion: string,
  snapshotId: string,
): number {
  const maskBytes = mask ? mask.byteLength : 0
  const normBytes = rowNorms ? rowNorms.byteLength : 0
  const dataBytes = computeDataByteLength(payload)
  const metaBytes = computeMetadataByteLength(representationVersion, snapshotId)
  return safeProduct(
    [maskBytes + normBytes + dataBytes + metaBytes],
    'vector payload',
  )
}

export function serializeVectorPack(params: {
  nextId: number
  documentCount: number
  mappingFingerprint: number
  dim: number
  metric: VectorMetric
  normalized: boolean
  presentMask: Uint8Array | null
  rowNorms: Float32Array | null
  payload: VectorPayload
  payloadBytes: number
  representationVersion: string
  snapshotId: string
}): Uint8Array {
  assertLittleEndianHost()
  const {
    nextId,
    documentCount,
    mappingFingerprint,
    dim,
    metric,
    normalized,
    presentMask,
    rowNorms,
    payload,
    payloadBytes,
    representationVersion,
    snapshotId,
  } = params
  const reprBytes = utf8Bytes(representationVersion)
  const snapBytes = utf8Bytes(snapshotId)

  const totalBytes = VECTOR_HEADER_SIZE + payloadBytes
  const out = new Uint8Array(totalBytes)
  const flags =
    (normalized ? FLAG_NORMALIZED : 0) |
    (presentMask !== null ? FLAG_HAS_PRESENT_MASK : 0) |
    (rowNorms !== null ? FLAG_HAS_ROW_NORMS : 0) |
    (metric === 'cosine' ? FLAG_METRIC_COSINE : 0)

  const pqSub = payload.kind === KIND_PQ_U8 ? payload.subspaces : 0
  const pqCen = payload.kind === KIND_PQ_U8 ? payload.centroidsPerSubspace : 0

  writeAscii(out, 0, VECTOR_MAGIC)
  writeU16LE(out, 4, VECTOR_VERSION)
  writeU8(out, 6, payload.kind)
  writeU8(out, 7, flags)
  writeU32LE(out, 8, dim)
  writeU32LE(out, 12, nextId)
  writeU32LE(out, 16, documentCount)
  writeU32LE(out, 20, mappingFingerprint)
  writeU16LE(out, 24, pqSub)
  writeU16LE(out, 26, pqCen)
  writeU32LE(out, 28, payloadBytes)

  let offset = VECTOR_HEADER_SIZE
  if (presentMask !== null) {
    offset = copyTypedBytes(presentMask, out, offset)
  }
  if (rowNorms !== null) {
    offset = copyTypedBytes(
      new Uint8Array(rowNorms.buffer, rowNorms.byteOffset, rowNorms.byteLength),
      out,
      offset,
    )
  }
  if (payload.kind === KIND_FLOAT32) {
    offset = copyTypedBytes(
      new Uint8Array(
        payload.vectors.buffer,
        payload.vectors.byteOffset,
        payload.vectors.byteLength,
      ),
      out,
      offset,
    )
  } else if (payload.kind === KIND_INT8) {
    offset = copyTypedBytes(
      new Uint8Array(
        payload.scales.buffer,
        payload.scales.byteOffset,
        payload.scales.byteLength,
      ),
      out,
      offset,
    )
    offset = copyTypedBytes(
      new Uint8Array(
        payload.codes.buffer,
        payload.codes.byteOffset,
        payload.codes.byteLength,
      ),
      out,
      offset,
    )
  } else {
    offset = copyTypedBytes(
      new Uint8Array(
        payload.centroids.buffer,
        payload.centroids.byteOffset,
        payload.centroids.byteLength,
      ),
      out,
      offset,
    )
    offset = copyTypedBytes(
      new Uint8Array(
        payload.codes.buffer,
        payload.codes.byteOffset,
        payload.codes.byteLength,
      ),
      out,
      offset,
    )
  }

  writeU16LE(out, offset, reprBytes.byteLength)
  offset += 2
  offset = copyTypedBytes(reprBytes, out, offset)
  writeU16LE(out, offset, snapBytes.byteLength)
  offset += 2
  offset = copyTypedBytes(snapBytes, out, offset)

  const payloadCrc = crc32Update(0, out, VECTOR_HEADER_SIZE, out.length) >>> 0
  writeU32LE(out, 32, payloadCrc)
  const headerCrc = crc32Update(0, out, 0, 36) >>> 0
  writeU32LE(out, 36, headerCrc)
  return out
}

export function ingestDenseVectors(
  binding: VectorCorpusBinding,
  vectors: Float32Array,
  dim: number,
  normalize: boolean,
): { work: Float32Array; mask: Uint8Array | null; presentCount: number } {
  const nextId = binding.nextId
  const expectedLen = nextId * dim
  if (vectors.length !== expectedLen) {
    throw new RangeError(
      `FrozenVectorIndex: expected Float32Array length ${expectedLen} (nextId=${nextId} * dim=${dim}), got ${vectors.length}`,
    )
  }
  const hasHoles = binding.documentCount < nextId
  const mask = hasHoles ? new Uint8Array(presentMaskByteLength(nextId)) : null
  const work = new Float32Array(expectedLen)

  for (let shortId = 0; shortId < nextId; shortId++) {
    if (!isLiveShortId(binding, shortId)) continue
    if (mask !== null) setMaskBit(mask, shortId)
    const base = shortId * dim
    readAndNormalizeVector(vectors, base, work, base, dim, normalize, shortId)
  }

  return { work, mask, presentCount: binding.documentCount }
}

export function ingestDocumentVectors<Id>(
  binding: VectorCorpusBinding,
  entries: Iterable<DocumentVectorEntry<Id>>,
  dim: number,
  normalize: boolean,
  requireAllLiveDocs: boolean,
): { work: Float32Array; mask: Uint8Array | null; presentCount: number } {
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
    readAndNormalizeVector(
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

  if (requireAllLiveDocs && presentCount !== binding.documentCount) {
    throw new RangeError(
      `FrozenVectorIndex: expected ${binding.documentCount} live document vectors, got ${presentCount}`,
    )
  }

  return {
    work,
    mask: presentCount < nextId ? seen : null,
    presentCount,
  }
}

export function readPackMetadata(
  bytes: Uint8Array,
  offset: number,
  payloadEnd: number,
): { representationVersion: string; snapshotId: string } {
  if (offset + 4 > payloadEnd) {
    throw new RangeError('FrozenVectorIndex: truncated metadata header')
  }
  const reprLen = readU16LE(bytes, offset)
  const reprStart = offset + 2
  const reprEnd = reprStart + reprLen
  if (reprLen === 0 || reprEnd + 2 > payloadEnd) {
    throw new RangeError(
      'FrozenVectorIndex: invalid representationVersion length',
    )
  }
  const representationVersion = readUtf8(bytes, reprStart, reprEnd)
  const snapLen = readU16LE(bytes, reprEnd)
  const snapStart = reprEnd + 2
  const snapEnd = snapStart + snapLen
  if (snapLen === 0 || snapEnd !== payloadEnd) {
    throw new RangeError('FrozenVectorIndex: invalid snapshotId length')
  }
  const snapshotId = readUtf8(bytes, snapStart, snapEnd)
  return { representationVersion, snapshotId }
}

export {
  assertLittleEndianHost,
  readAscii,
  readU16LE,
  readU32LE,
  readU8,
  snapshotBytes,
}
