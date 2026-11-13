import { crc32Update } from './crc32Wire'
import {
  type VectorCorpusBinding,
  type VectorCorpusHost,
} from './frozenVectorBinding'
import {
  assertDim,
  assertLittleEndianHost,
  assertMetadataString,
  assertMetric,
  buildInt8Payload,
  computeMappingFingerprint,
  computePayloadBytes,
  computeReconstructedRowNorms,
  countMaskBits,
  FLAG_HAS_PRESENT_MASK,
  FLAG_HAS_ROW_NORMS,
  FLAG_METRIC_COSINE,
  FLAG_NORMALIZED,
  FLOAT32_MIN_NORMAL,
  type FromDocumentVectorsOptions,
  type FrozenVectorIndexStats,
  ingestDenseVectors,
  ingestDocumentVectors,
  isLiveShortId,
  isMaskBitSet,
  KIND_FLOAT32,
  KIND_INT8,
  KIND_PQ_U8,
  KNOWN_FLAGS,
  presentMaskByteLength,
  readAndNormalizeVector,
  readAscii,
  readCorpusBinding,
  readExpectation,
  readOwnedFloat32Slice,
  readPackMetadata,
  readU16LE,
  readU32LE,
  readU8,
  resolveExternalId,
  safeProduct,
  serializeVectorPack,
  snapshotBytes,
  VECTOR_HEADER_SIZE,
  VECTOR_MAGIC,
  VECTOR_VERSION,
  type VectorExpectation,
  type VectorIndexOptions,
  type VectorMetric,
  type VectorPayload,
  type VectorQuantization,
  type VectorSearchHit,
  type VectorSearchOptions,
  type DocumentVectorEntry,
} from './frozenVectorsShared'

export type {
  DocumentVectorEntry,
  FromDocumentVectorsOptions,
  FrozenVectorIndexStats,
  VectorExpectation,
  VectorIndexOptions,
  VectorMetric,
  VectorQuantization,
  VectorSearchHit,
  VectorSearchOptions,
}

function buildInvNorms(rowNorms: Float32Array | null): Float64Array | null {
  if (rowNorms === null) return null
  const inv = new Float64Array(rowNorms.length)
  for (let i = 0; i < rowNorms.length; i++) {
    const n = rowNorms[i]
    if (n === 0) {
      inv[i] = 0
    } else if (Number.isFinite(n) && n >= FLOAT32_MIN_NORMAL) {
      inv[i] = 1 / n
    } else {
      throw new RangeError(
        `FrozenVectorIndex: row norm ${n} at index ${i} is outside normal float32 range`,
      )
    }
  }
  return inv
}

function assertValidPackFlags(
  kind: number,
  normalized: boolean,
  hasMask: boolean,
  hasRowNorms: boolean,
  metric: VectorMetric,
  documentCount: number,
  nextId: number,
): void {
  if (kind === KIND_FLOAT32 && normalized && hasRowNorms) {
    throw new Error(
      'FrozenVectorIndex: normalized float32 pack must not declare stored row norms',
    )
  }
  if (metric === 'dot' && hasRowNorms) {
    throw new Error(
      'FrozenVectorIndex: dot-metric pack must not declare stored row norms',
    )
  }
  if (
    metric === 'cosine' &&
    !(kind === KIND_FLOAT32 && normalized) &&
    !hasRowNorms
  ) {
    throw new Error(
      'FrozenVectorIndex: cosine pack without unit float32 vectors must include reconstructed row norms',
    )
  }
  if (documentCount < nextId && !hasMask) {
    throw new Error(
      'FrozenVectorIndex: corpus contains deleted slots but pack omits presentMask',
    )
  }
}

function validateFloat32Payload(
  vectors: Float32Array,
  nextId: number,
  dim: number,
  presentMask: Uint8Array | null,
): void {
  if (presentMask === null) return
  for (let i = 0; i < nextId; i++) {
    if (isMaskBitSet(presentMask, i)) continue
    const base = i * dim
    for (let d = 0; d < dim; d++) {
      if (vectors[base + d] !== 0) {
        throw new Error(
          `FrozenVectorIndex: non-zero float32 component in absent slot ${i}`,
        )
      }
    }
  }
}

function validateInt8Payload(
  scales: Float32Array,
  codes: Int8Array,
  nextId: number,
  dim: number,
  presentMask: Uint8Array | null,
): void {
  for (let i = 0; i < scales.length; i++) {
    const scale = scales[i]
    if (scale < 0) {
      throw new RangeError(
        `FrozenVectorIndex: negative int8 scale at index ${i}`,
      )
    }
    if (
      scale !== 0 &&
      (!Number.isFinite(scale) || scale < FLOAT32_MIN_NORMAL)
    ) {
      throw new RangeError(
        `FrozenVectorIndex: int8 scale ${scale} at index ${i} is below normal float32 range`,
      )
    }
  }
  for (let i = 0; i < nextId; i++) {
    const present = presentMask === null || isMaskBitSet(presentMask, i)
    const scale = scales[i]
    if (!present && scale !== 0) {
      throw new Error(
        `FrozenVectorIndex: non-zero int8 scale in absent slot ${i}`,
      )
    }
    const base = i * dim
    for (let d = 0; d < dim; d++) {
      const code = codes[base + d]
      if (code < -127) {
        throw new RangeError(
          `FrozenVectorIndex: int8 code ${code} outside symmetric [-127, 127] at index ${i}`,
        )
      }
      if ((!present || scale === 0) && code !== 0) {
        throw new Error(
          `FrozenVectorIndex: non-zero int8 code with zero/absent scale at index ${i}`,
        )
      }
    }
  }
}

function validatePqPayload(
  codes: Uint8Array,
  nextId: number,
  subspaces: number,
  pqCentroids: number,
  presentMask: Uint8Array | null,
): void {
  if (pqCentroids < 256) {
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] >= pqCentroids) {
        throw new RangeError(
          `FrozenVectorIndex: PQ code ${codes[i]} exceeds centroid count ${pqCentroids}`,
        )
      }
    }
  }
  if (presentMask === null) return
  for (let i = 0; i < nextId; i++) {
    if (isMaskBitSet(presentMask, i)) continue
    const base = i * subspaces
    for (let m = 0; m < subspaces; m++) {
      if (codes[base + m] !== 0) {
        throw new Error(
          `FrozenVectorIndex: non-zero PQ code in absent slot ${i}`,
        )
      }
    }
  }
}

function verifyNormalizedFloat32Norms(
  reconstructed: Float32Array,
  nextId: number,
  presentMask: Uint8Array | null,
): void {
  for (let i = 0; i < nextId; i++) {
    if (presentMask !== null && !isMaskBitSet(presentMask, i)) continue
    const n = reconstructed[i]
    if (n !== 0 && Math.abs(n - 1) > 1e-4) {
      throw new Error(
        `FrozenVectorIndex: unnormalized float32 vector at index ${i} (norm=${n})`,
      )
    }
  }
}

function verifyStoredRowNorms(
  storedNorms: Float32Array,
  reconstructed: Float32Array,
  nextId: number,
  presentMask: Uint8Array | null,
): void {
  for (let i = 0; i < nextId; i++) {
    const present = presentMask === null || isMaskBitSet(presentMask, i)
    const stored = storedNorms[i]
    const expected = reconstructed[i]
    if (!present) {
      if (stored !== 0) {
        throw new Error(
          `FrozenVectorIndex: non-zero stored row norm ${stored} for absent slot ${i}`,
        )
      }
      continue
    }
    if (expected === 0) {
      if (stored !== 0) {
        throw new Error(
          `FrozenVectorIndex: row norm mismatch at index ${i} (expected 0, got ${stored})`,
        )
      }
      continue
    }
    if (expected < FLOAT32_MIN_NORMAL) {
      throw new RangeError(
        `FrozenVectorIndex: reconstructed row norm ${expected} at index ${i} is below normal float32 range`,
      )
    }
    const tol = 1e-4 * expected
    if (stored <= 0 || Math.abs(stored - expected) > tol) {
      throw new Error(
        `FrozenVectorIndex: row norm mismatch at index ${i} (expected ${expected}, got ${stored})`,
      )
    }
  }
}

function buildRuntimePayloadFromWork(
  work: Float32Array,
  nextId: number,
  dim: number,
  mask: Uint8Array | null,
  options: VectorIndexOptions,
): VectorPayload {
  const quant = options.quantization ?? 'int8'
  if (quant === 'float32') {
    return { kind: KIND_FLOAT32, vectors: work }
  }
  if (quant === 'int8') {
    return buildInt8Payload(work, nextId, dim, mask)
  }
  if (quant === 'pq') {
    throw new TypeError(
      'FrozenVectorIndex: PQ codebook training is separated into @yoch/frozenminisearch/vectors/train (use encodeDenseVectorPack / encodeDocumentVectorPack + FrozenVectorIndex.loadBinary)',
    )
  }
  throw new TypeError(
    `FrozenVectorIndex: unsupported quantization "${String(quant)}"`,
  )
}

/**
 * Auxiliary quantized or dense vector representation bound to a {@link FrozenMiniSearch} corpus.
 * Zero-dependency, Node + Browser compatible, and non-invasive to lexical indexing.
 *
 * Raw query vectors passed to {@link topK} or {@link scoreDocument} are checked only for
 * dimensionality, finiteness, and float32 range/normalization; verifying that a query vector
 * came from the same upstream model, tokenizer, and preprocessing as {@link representationVersion}
 * is enforced via {@link assertCompatibleWith} and {@link loadBinary} metadata rather than inferred
 * from raw numbers.
 */
export class FrozenVectorIndex<Id = unknown> {
  private readonly _binding: VectorCorpusBinding
  private readonly _mappingFingerprint: number
  private readonly _representationVersion: string
  private readonly _snapshotId: string
  private readonly _dim: number
  private readonly _metric: VectorMetric
  private readonly _normalized: boolean
  private readonly _presentMask: Uint8Array | null
  private readonly _presentCount: number
  private readonly _rowNorms: Float32Array | null
  private readonly _invRowNorms: Float64Array | null
  private readonly _payload: VectorPayload
  private readonly _payloadBytes: number

  private constructor(
    binding: VectorCorpusBinding,
    mappingFingerprint: number,
    representationVersion: string,
    snapshotId: string,
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
    this._mappingFingerprint = mappingFingerprint
    this._representationVersion = representationVersion
    this._snapshotId = snapshotId
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

  private static fromWorkVectors<Id>(
    binding: VectorCorpusBinding,
    work: Float32Array,
    dim: number,
    normalize: boolean,
    mask: Uint8Array | null,
    presentCount: number,
    options: VectorIndexOptions,
  ): FrozenVectorIndex<Id> {
    const representationVersion = assertMetadataString(
      options.representationVersion,
      'representationVersion',
    )
    const snapshotId = assertMetadataString(options.snapshotId, 'snapshotId')
    const metric: VectorMetric = options.metric ?? 'cosine'
    assertMetric(metric)
    const nextId = binding.nextId
    const mappingFp = computeMappingFingerprint(binding)
    const payload = buildRuntimePayloadFromWork(
      work,
      nextId,
      dim,
      mask,
      options,
    )
    const storeNorms =
      metric === 'cosine' && !(payload.kind === KIND_FLOAT32 && normalize)
    const rowNorms = storeNorms
      ? computeReconstructedRowNorms(payload, nextId, dim, mask)
      : null
    const payloadBytes = computePayloadBytes(
      mask,
      rowNorms,
      payload,
      representationVersion,
      snapshotId,
    )
    return new FrozenVectorIndex<Id>(
      binding,
      mappingFp,
      representationVersion,
      snapshotId,
      dim,
      metric,
      normalize,
      mask,
      presentCount,
      rowNorms,
      payload,
      payloadBytes,
    )
  }

  /** Build a `float32` or `int8` vector index from a `shortId`-aligned `Float32Array` of length `nextId * dim`. */
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
    assertMetadataString(options.representationVersion, 'representationVersion')
    assertMetadataString(options.snapshotId, 'snapshotId')
    const dim = options.dim
    const binding = readCorpusBinding(host)
    const normalize = options.normalize === true
    const { work, mask, presentCount } = ingestDenseVectors(
      binding,
      vectors,
      dim,
      normalize,
    )
    return FrozenVectorIndex.fromWorkVectors<Id>(
      binding,
      work,
      dim,
      normalize,
      mask,
      presentCount,
      options,
    )
  }

  /** Build a `float32` or `int8` vector index from `{ id, vector }` or `[id, vector]` entries keyed by external document id. */
  static fromDocumentVectors<Id = unknown>(
    host: VectorCorpusHost,
    entries: Iterable<DocumentVectorEntry<Id>>,
    options: FromDocumentVectorsOptions,
  ): FrozenVectorIndex<Id> {
    assertDim(options.dim)
    assertMetadataString(options.representationVersion, 'representationVersion')
    assertMetadataString(options.snapshotId, 'snapshotId')
    const dim = options.dim
    const normalize = options.normalize === true
    const requireAll = options.requireAllLiveDocs !== false
    const binding = readCorpusBinding(host)
    const { work, mask, presentCount } = ingestDocumentVectors(
      binding,
      entries,
      dim,
      normalize,
      requireAll,
    )
    return FrozenVectorIndex.fromWorkVectors<Id>(
      binding,
      work,
      dim,
      normalize,
      mask,
      presentCount,
      options,
    )
  }

  /**
   * Decode a binary `FXV1` (v2) vector pack and verify CRC-32 corruption checks,
   * numerical invariants (scale-relative reconstructed norm verification including
   * zero vs non-zero distinction, normal float32 domain, unit norm flag, and
   * scale/code bounds), expected representation/snapshot metadata, and host
   * mapping compatibility. Operational cosine scoring always uses the verified
   * reconstructed norms rather than trusting stored row norms directly.
   *
   * Note: CRC-32 checksums detect accidental corruption only and provide no
   * cryptographic authenticity against adversarial tampering.
   */
  static loadBinary<Id = unknown>(
    input: unknown,
    host: VectorCorpusHost,
    expected: VectorExpectation,
  ): FrozenVectorIndex<Id> {
    assertLittleEndianHost()
    const exp = readExpectation(expected)
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
    const mappingFingerprint = readU32LE(bytes, 20)
    const pqSubspaces = readU16LE(bytes, 24)
    const pqCentroids = readU16LE(bytes, 26)
    const payloadByteLength = readU32LE(bytes, 28)
    const storedPayloadCrc = readU32LE(bytes, 32)

    assertValidPackFlags(
      kind,
      normalized,
      hasMask,
      hasRowNorms,
      metric,
      documentCount,
      nextId,
    )

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

    const fixedPayloadLen = maskBytesLen + normBytesLen + dataBytesLen
    if (fixedPayloadLen + 4 > payloadByteLength) {
      throw new RangeError(
        `FrozenVectorIndex: payload size mismatch (need >= ${fixedPayloadLen + 4}, got ${payloadByteLength})`,
      )
    }

    const meta = readPackMetadata(
      bytes,
      VECTOR_HEADER_SIZE + fixedPayloadLen,
      VECTOR_HEADER_SIZE + payloadByteLength,
    )
    if (meta.representationVersion !== exp.representationVersion) {
      throw new Error(
        `FrozenVectorIndex: representationVersion mismatch (pack="${meta.representationVersion}", expected="${exp.representationVersion}")`,
      )
    }
    if (meta.snapshotId !== exp.snapshotId) {
      throw new Error(
        `FrozenVectorIndex: snapshotId mismatch (pack="${meta.snapshotId}", expected="${exp.snapshotId}")`,
      )
    }

    const binding = readCorpusBinding(host)
    if (binding.documentCount !== documentCount || binding.nextId !== nextId) {
      throw new Error(
        `FrozenVectorIndex: corpus shape mismatch (pack documentCount=${documentCount}, nextId=${nextId}; host documentCount=${binding.documentCount}, nextId=${binding.nextId})`,
      )
    }
    const hostFp = computeMappingFingerprint(binding)
    if (hostFp !== mappingFingerprint) {
      throw new Error(
        `FrozenVectorIndex: corpus fingerprint mismatch (pack=0x${mappingFingerprint.toString(16)}, host=0x${hostFp.toString(16)})`,
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
    }

    let storedRowNorms: Float32Array | null = null
    if (hasRowNorms) {
      const normRes = readOwnedFloat32Slice(bytes, cursor, nextId, 'row norm')
      for (let i = 0; i < normRes.arr.length; i++) {
        const n = normRes.arr[i]
        if (n < 0) {
          throw new RangeError(
            `FrozenVectorIndex: negative row norm at index ${i}`,
          )
        }
        if (n > 0 && n < FLOAT32_MIN_NORMAL) {
          throw new RangeError(
            `FrozenVectorIndex: subnormal stored row norm ${n} at index ${i} is below normal float32 range`,
          )
        }
      }
      storedRowNorms = normRes.arr
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
      validateFloat32Payload(res.arr, nextId, dim, presentMask)
      payload = { kind: KIND_FLOAT32, vectors: res.arr }
    } else if (kind === KIND_INT8) {
      const scalesRes = readOwnedFloat32Slice(
        bytes,
        cursor,
        nextId,
        'int8 scale',
      )
      cursor = scalesRes.nextOffset
      const codeLen = nextId * dim
      const codeBytes = new Int8Array(codeLen)
      codeBytes.set(
        new Int8Array(bytes.buffer, bytes.byteOffset + cursor, codeLen),
      )
      validateInt8Payload(scalesRes.arr, codeBytes, nextId, dim, presentMask)
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
      validatePqPayload(
        codeBytes,
        nextId,
        pqSubspaces,
        pqCentroids,
        presentMask,
      )
      payload = {
        kind: KIND_PQ_U8,
        subspaces: pqSubspaces,
        centroidsPerSubspace: pqCentroids,
        subDim,
        centroids: cenRes.arr,
        codes: codeBytes,
      }
    }

    const needNormCheck = hasRowNorms || (kind === KIND_FLOAT32 && normalized)
    let effectiveRowNorms: Float32Array | null = null
    if (needNormCheck) {
      const reconstructed = computeReconstructedRowNorms(
        payload,
        nextId,
        dim,
        presentMask,
      )
      if (kind === KIND_FLOAT32 && normalized) {
        verifyNormalizedFloat32Norms(reconstructed, nextId, presentMask)
      }
      if (storedRowNorms !== null) {
        verifyStoredRowNorms(storedRowNorms, reconstructed, nextId, presentMask)
        // Reconstructed norms remain authoritative for scoring and subsequent saves.
        effectiveRowNorms = reconstructed
      }
    }

    return new FrozenVectorIndex<Id>(
      binding,
      mappingFingerprint,
      meta.representationVersion,
      meta.snapshotId,
      dim,
      metric,
      normalized,
      presentMask,
      presentCount,
      effectiveRowNorms,
      payload,
      payloadByteLength,
    )
  }

  /**
   * Compute structural slot + external-ID mapping CRC-32 fingerprint for a {@link FrozenMiniSearch} host.
   * Note: covers slot counts, holes, and typed (`string | finite number`) IDs only; does not cover
   * document text, entity ordering behind `0..N-1` IDs, model, or preprocessing.
   */
  static mappingFingerprint(host: VectorCorpusHost): number {
    return computeMappingFingerprint(readCorpusBinding(host))
  }

  /** @see {@link mappingFingerprint} */
  static corpusFingerprint(host: VectorCorpusHost): number {
    return FrozenVectorIndex.mappingFingerprint(host)
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

  get mappingFingerprint(): number {
    return this._mappingFingerprint
  }

  get corpusFingerprint(): number {
    return this._mappingFingerprint
  }

  get representationVersion(): string {
    return this._representationVersion
  }

  get snapshotId(): string {
    return this._snapshotId
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
      documentCount: this._binding.documentCount,
      nextId: this._binding.nextId,
      corpusFingerprint: this._mappingFingerprint,
      mappingFingerprint: this._mappingFingerprint,
      representationVersion: this._representationVersion,
      snapshotId: this._snapshotId,
      presentCount: this._presentCount,
      pqSubspaces: this.pqSubspaces,
      pqCentroidsPerSubspace: this.pqCentroidsPerSubspace,
      normalized: this._normalized,
      hasReconstructedNorms: this._rowNorms !== null,
      byteLength: this.byteLength,
    }
  }

  hasVector(id: Id): boolean {
    const shortId = this._binding.lookup.get(id)
    if (shortId === undefined) return false
    return (
      this._presentMask === null || isMaskBitSet(this._presentMask, shortId)
    )
  }

  /**
   * Verify that this vector index matches the given lexical host mapping AND
   * consumer-supplied `expected` representation/snapshot identifiers.
   */
  assertCompatibleWith(
    host: VectorCorpusHost,
    expected: VectorExpectation,
  ): void {
    const exp = readExpectation(expected)
    if (exp.representationVersion !== this._representationVersion) {
      throw new Error(
        `FrozenVectorIndex: representationVersion mismatch (vector="${this._representationVersion}", expected="${exp.representationVersion}")`,
      )
    }
    if (exp.snapshotId !== this._snapshotId) {
      throw new Error(
        `FrozenVectorIndex: snapshotId mismatch (vector="${this._snapshotId}", expected="${exp.snapshotId}")`,
      )
    }
    const other = readCorpusBinding(host)
    if (
      other.documentCount !== this._binding.documentCount ||
      other.nextId !== this._binding.nextId
    ) {
      throw new Error(
        `FrozenVectorIndex: corpus shape mismatch (vector documentCount=${this._binding.documentCount}, nextId=${this._binding.nextId}; host documentCount=${other.documentCount}, nextId=${other.nextId})`,
      )
    }
    const otherFp = computeMappingFingerprint(other)
    if (otherFp !== this._mappingFingerprint) {
      throw new Error(
        `FrozenVectorIndex: corpus fingerprint mismatch (vector=0x${this._mappingFingerprint.toString(16)}, host=0x${otherFp.toString(16)})`,
      )
    }
  }

  /** Serialize this vector index to portable little-endian `FXV1` (v2) bytes (Node + Browser). */
  saveBinary(): Uint8Array {
    return serializeVectorPack({
      nextId: this._binding.nextId,
      documentCount: this._binding.documentCount,
      mappingFingerprint: this._mappingFingerprint,
      dim: this._dim,
      metric: this._metric,
      normalized: this._normalized,
      presentMask: this._presentMask,
      rowNorms: this._rowNorms,
      payload: this._payload,
      payloadBytes: this._payloadBytes,
      representationVersion: this._representationVersion,
      snapshotId: this._snapshotId,
    })
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

  /**
   * Score a single document by external ID (`undefined` if unknown or missing vector).
   * Note: raw query vectors are validated only for dimension, finiteness, and float32 conversion/normalization;
   * callers must ensure query vectors were encoded using the matching {@link representationVersion}.
   */
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

  /**
   * Find top-`k` documents matching `queryVector` with optional `minScore`, `metric`, and pre-`k` predicate `filter`.
   * Note: raw query vectors are checked for dimension, finiteness, and float32 range/normalization only;
   * matching the upstream encoder/tokenizer/preprocessing indicated by {@link representationVersion} is the caller's contract.
   */
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
  const isZero = readAndNormalizeVector(
    queryVector,
    0,
    q,
    0,
    dim,
    normalize,
    'queryVector',
  )
  return { vec: q, isZero }
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
    const lutBase = m * K
    const cBase = m * K * subDim
    for (let k = 0; k < K; k++) {
      const kb = cBase + k * subDim
      let dot = 0
      for (let d = 0; d < subDim; d++) {
        dot += q[qBase + d] * centroids[kb + d]
      }
      lut[lutBase + k] = dot
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
  let score = 0
  for (let m = 0; m < M; m++) {
    score += lut[m * K + codes[codeBase + m]]
  }
  return score
}

function isBetterHit(
  shortId: number,
  score: number,
  rootId: number,
  rootScore: number,
): boolean {
  return score > rootScore || (score === rootScore && shortId < rootId)
}

function siftUp(ids: Int32Array, scores: Float64Array, idx: number): void {
  const targetId = ids[idx]
  const targetScore = scores[idx]
  while (idx > 0) {
    const parent = (idx - 1) >>> 1
    if (!isBetterHit(ids[parent], scores[parent], targetId, targetScore)) break
    ids[idx] = ids[parent]
    scores[idx] = scores[parent]
    idx = parent
  }
  ids[idx] = targetId
  scores[idx] = targetScore
}

function siftDown(ids: Int32Array, scores: Float64Array, size: number): void {
  const targetId = ids[0]
  const targetScore = scores[0]
  let idx = 0
  const half = size >>> 1
  while (idx < half) {
    let worst = (idx << 1) + 1
    const right = worst + 1
    if (
      right < size &&
      isBetterHit(ids[worst], scores[worst], ids[right], scores[right])
    ) {
      worst = right
    }
    if (!isBetterHit(targetId, targetScore, ids[worst], scores[worst])) break
    ids[idx] = ids[worst]
    scores[idx] = scores[worst]
    idx = worst
  }
  ids[idx] = targetId
  scores[idx] = targetScore
}
