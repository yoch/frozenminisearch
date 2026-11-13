import {
  type VectorCorpusBinding,
  type VectorCorpusHost,
} from './frozenVectorBinding'
import {
  assertDim,
  assertMetadataString,
  assertMetric,
  buildInt8Payload,
  computeMappingFingerprint,
  computePayloadBytes,
  computeReconstructedRowNorms,
  type DocumentVectorEntry,
  type FromDocumentVectorsOptions,
  ingestDenseVectors,
  ingestDocumentVectors,
  isMaskBitSet,
  KIND_FLOAT32,
  KIND_PQ_U8,
  readCorpusBinding,
  resolvePqSubspaces,
  serializeVectorPack,
  type VectorIndexOptions,
  type VectorMetric,
  type VectorPayload,
} from './frozenVectorsShared'

/**
 * Select up to `maxSamples` evenly spaced distinct slots from `liveShortIds`.
 * Strictly enforces `result.length <= maxSamples`.
 */
export function selectPqSampleIndices(
  liveShortIds: Int32Array,
  maxSamples: number,
): Int32Array {
  const presentCount = liveShortIds.length
  const sampleCount = Math.min(presentCount, maxSamples)
  const sampleIds = new Int32Array(sampleCount)
  if (sampleCount === presentCount) {
    sampleIds.set(liveShortIds)
    return sampleIds
  }
  for (let s = 0; s < sampleCount; s++) {
    const idx = Math.floor((s * presentCount) / sampleCount)
    sampleIds[s] = liveShortIds[idx]
  }
  return sampleIds
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

  const sampleIds = selectPqSampleIndices(liveShortIds, maxSamples)
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

function buildAnyPayload(
  work: Float32Array,
  nextId: number,
  dim: number,
  mask: Uint8Array | null,
  presentCount: number,
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
    return buildPqPayload(work, nextId, dim, mask, presentCount, options)
  }
  throw new TypeError(
    `FrozenVectorIndex: unsupported quantization "${String(quant)}"`,
  )
}

function finalizePack(
  binding: VectorCorpusBinding,
  work: Float32Array,
  dim: number,
  normalize: boolean,
  mask: Uint8Array | null,
  presentCount: number,
  options: VectorIndexOptions,
): Uint8Array {
  const representationVersion = assertMetadataString(
    options.representationVersion,
    'representationVersion',
  )
  const snapshotId = assertMetadataString(options.snapshotId, 'snapshotId')
  const metric: VectorMetric = options.metric ?? 'cosine'
  assertMetric(metric)
  const nextId = binding.nextId
  const mappingFingerprint = computeMappingFingerprint(binding)
  const payload = buildAnyPayload(
    work,
    nextId,
    dim,
    mask,
    presentCount,
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
  return serializeVectorPack({
    nextId,
    documentCount: binding.documentCount,
    mappingFingerprint,
    dim,
    metric,
    normalized: normalize,
    presentMask: mask,
    rowNorms,
    payload,
    payloadBytes,
    representationVersion,
    snapshotId,
  })
}

/**
 * Offline/build-time pack encoder supporting `float32`, `int8`, and `pq` (k-means quantization).
 * Produces binary `FXV1` (v2) bytes loadable with `FrozenVectorIndex.loadBinary(bytes, host, expected)`.
 */
export function encodeDenseVectorPack(
  host: VectorCorpusHost,
  vectors: Float32Array,
  options: VectorIndexOptions,
): Uint8Array {
  if (!(vectors instanceof Float32Array)) {
    throw new TypeError(
      'FrozenVectorIndex: encodeDenseVectorPack expects a Float32Array',
    )
  }
  assertDim(options.dim)
  assertMetadataString(options.representationVersion, 'representationVersion')
  assertMetadataString(options.snapshotId, 'snapshotId')
  const binding = readCorpusBinding(host)
  const normalize = options.normalize === true
  const { work, mask, presentCount } = ingestDenseVectors(
    binding,
    vectors,
    options.dim,
    normalize,
  )
  return finalizePack(
    binding,
    work,
    options.dim,
    normalize,
    mask,
    presentCount,
    options,
  )
}

/**
 * Offline/build-time pack encoder from keyed `{ id, vector }` / `[id, vector]` entries,
 * supporting `float32`, `int8`, and `pq`.
 */
export function encodeDocumentVectorPack<Id = unknown>(
  host: VectorCorpusHost,
  entries: Iterable<DocumentVectorEntry<Id>>,
  options: FromDocumentVectorsOptions,
): Uint8Array {
  assertDim(options.dim)
  assertMetadataString(options.representationVersion, 'representationVersion')
  assertMetadataString(options.snapshotId, 'snapshotId')
  const binding = readCorpusBinding(host)
  const normalize = options.normalize === true
  const requireAll = options.requireAllLiveDocs !== false
  const { work, mask, presentCount } = ingestDocumentVectors(
    binding,
    entries,
    options.dim,
    normalize,
    requireAll,
  )
  return finalizePack(
    binding,
    work,
    options.dim,
    normalize,
    mask,
    presentCount,
    options,
  )
}
