import SearchableMap from './SearchableMap/SearchableMap'
import { fromRadixTree } from './PackedRadixTree'
import { createIdToShortIdLookup } from './frozenIdLookup'
import { materializeFieldLengthMatrix } from './fieldLengthMatrix'
import { materializeFrozenPostings } from './frozenPostings'
import { resolveIndexingOptions } from './indexingCore'
import { storedFieldsFromRows } from './storedFieldsLayout'
import { DISCARDED_DOC_ID } from './flatPostings'
import type { FrozenAssembleParams } from './frozenTypes'
import type { Options } from './searchTypes'

/** MiniSearch JSON snapshot (`toJSON` wire format, `serializationVersion` 1 or 2). */
export type SerializedIndexEntry = Record<string, number>

export type MiniSearchSnapshot = {
  documentCount: number
  nextId: number
  documentIds: { [shortId: string]: unknown }
  fieldIds: { [fieldName: string]: number }
  fieldLength: { [shortId: string]: number[] }
  averageFieldLength: number[]
  storedFields: { [shortId: string]: Record<string, unknown> | undefined }
  dirtCount?: number
  index: [string, { [fieldId: string]: SerializedIndexEntry | { ds: SerializedIndexEntry } }][]
  serializationVersion: number
}

const SUPPORTED_SERIALIZATION_VERSIONS = new Set([1, 2])

type MutableFieldTermData = Map<number, Map<number, number>>

function snapshotError(detail: string): Error {
  return new Error(`FrozenMiniSearch: invalid MiniSearch snapshot: ${detail}`)
}

function assertRecord(value: unknown, context: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw snapshotError(`${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertNonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw snapshotError(`${context} must be a non-negative integer`)
  }
  return value as number
}

function parseIntegerKey(key: string, context: string): number {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    throw snapshotError(`${context} key "${key}" must be a non-negative integer`)
  }
  return assertNonNegativeInteger(Number(key), `${context} key "${key}"`)
}

function assertShortIdInRange(shortId: number, nextId: number, context: string): void {
  if (shortId >= nextId) {
    throw snapshotError(`${context} shortId ${shortId} must be < nextId ${nextId}`)
  }
}

function assertFrequency(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw snapshotError(`${context} frequency must be a positive integer`)
  }
  return value as number
}

function parseIndexEntry(
  entry: SerializedIndexEntry | { ds: SerializedIndexEntry },
  serializationVersion: number,
): SerializedIndexEntry {
  if (serializationVersion === 1 && entry != null && typeof entry === 'object' && 'ds' in entry) {
    return entry.ds as SerializedIndexEntry
  }
  return entry as SerializedIndexEntry
}

function assertFieldsMatchSnapshot(
  optionsFields: readonly string[],
  snapFieldIds: { [field: string]: number },
): void {
  const snapNames = Object.keys(snapFieldIds).sort()
  const optNames = [...optionsFields].sort()
  if (snapNames.length !== optNames.length || snapNames.some((name, i) => name !== optNames[i])) {
    throw new Error(
      `FrozenMiniSearch: option "fields" must match the indexed fields exactly (expected: ${snapNames.join(', ')})`,
    )
  }
}

function buildSearchableMapFromSnapshot(
  snapshot: MiniSearchSnapshot,
  fieldCount: number,
  nextId: number,
): SearchableMap<MutableFieldTermData> {
  const index = new SearchableMap<MutableFieldTermData>()
  const { index: entries, serializationVersion } = snapshot

  for (const [term, data] of entries) {
    assertRecord(data, `index term "${term}"`)
    const dataMap = new Map<number, Map<number, number>>() as MutableFieldTermData
    for (const fieldId of Object.keys(data)) {
      const parsedFieldId = parseIntegerKey(fieldId, `index term "${term}" fieldId`)
      if (parsedFieldId >= fieldCount) {
        throw snapshotError(`index term "${term}" fieldId ${parsedFieldId} must be < field count ${fieldCount}`)
      }
      const raw = data[fieldId]
      const indexEntry = parseIndexEntry(raw, serializationVersion)
      assertRecord(indexEntry, `index term "${term}" field ${fieldId}`)
      const freqs = new Map<number, number>()
      for (const [docId, freq] of Object.entries(indexEntry)) {
        const shortId = parseIntegerKey(docId, `index term "${term}" field ${fieldId} docId`)
        assertShortIdInRange(shortId, nextId, `index term "${term}" field ${fieldId}`)
        freqs.set(shortId, assertFrequency(freq, `index term "${term}" field ${fieldId} docId ${docId}`))
      }
      dataMap.set(parsedFieldId, freqs)
    }
    index.set(term, dataMap)
  }

  return index
}

function validateFieldIds(fieldIds: Record<string, unknown>, fieldCount: number): { [fieldName: string]: number } {
  const seen = new Set<number>()
  for (const [fieldName, rawFieldId] of Object.entries(fieldIds)) {
    const fieldId = assertNonNegativeInteger(rawFieldId, `fieldIds.${fieldName}`)
    if (fieldId >= fieldCount) {
      throw snapshotError(`fieldIds.${fieldName} must be < field count ${fieldCount}`)
    }
    if (seen.has(fieldId)) {
      throw snapshotError(`fieldId ${fieldId} is assigned more than once`)
    }
    seen.add(fieldId)
  }
  if (seen.size !== fieldCount) {
    throw snapshotError(`fieldIds must contain ${fieldCount} fields`)
  }
  return fieldIds as { [fieldName: string]: number }
}

function validateActiveShortIds(
  documentIds: Record<string, unknown>,
  documentCount: number,
  nextId: number,
): number[] {
  const shortIds = Object.keys(documentIds).map((shortIdStr) => {
    const shortId = parseIntegerKey(shortIdStr, 'documentIds')
    assertShortIdInRange(shortId, nextId, 'documentIds')
    return shortId
  })
  if (shortIds.length > documentCount) {
    throw snapshotError(`documentIds count ${shortIds.length} must be <= documentCount ${documentCount}`)
  }
  return shortIds
}

function buildFlatPostingsFromSearchableMap(
  searchableMap: SearchableMap<MutableFieldTermData>,
  fieldCount: number,
  nextId: number,
  shortIdRemap: Uint32Array | null,
): {
  termCount: number
  index: ReturnType<typeof fromRadixTree>
  postings: ReturnType<typeof materializeFrozenPostings>
} {
  const fieldIndexByTermIndex: MutableFieldTermData[] = []
  const packedIndex = fromRadixTree(searchableMap.radixTree, {
    termCount: 0,
    mapLeaf: (leaf) => {
      const ti = fieldIndexByTermIndex.length
      fieldIndexByTermIndex[ti] = leaf
      return ti
    },
    inferTermCountFromLeaves: true,
  })
  const termCount = packedIndex.size

  const remapDocId = shortIdRemap != null
    ? (docId: number) => shortIdRemap[docId]
    : undefined

  const postings = materializeFrozenPostings({
    fieldCount,
    termCount,
    nextId,
    clampFrequencies: true,
    remapDocId,
    forEachPosting(ti, f, emit) {
      const freqs = fieldIndexByTermIndex[ti]?.get(f)
      if (freqs == null) return
      for (const [shortId, freq] of freqs) {
        emit(shortId, freq)
      }
    },
  })

  return { termCount, index: packedIndex, postings }
}

/** Build frozen assemble params from a MiniSearch JSON snapshot. */
export function buildFrozenAssembleParamsFromMiniSearchSnapshot<T>(
  snapshot: MiniSearchSnapshot,
  options: Options<T>,
): FrozenAssembleParams<T> {
  assertRecord(snapshot, 'snapshot')
  const serializationVersion = assertNonNegativeInteger(
    snapshot.serializationVersion,
    'serializationVersion',
  )
  if (!SUPPORTED_SERIALIZATION_VERSIONS.has(serializationVersion)) {
    throw new Error(
      `FrozenMiniSearch: unsupported MiniSearch serializationVersion ${snapshot.serializationVersion}`,
    )
  }

  const documentIds = assertRecord(snapshot.documentIds, 'documentIds')
  const rawFieldIds = assertRecord(snapshot.fieldIds, 'fieldIds')
  const fieldLength = assertRecord(snapshot.fieldLength, 'fieldLength')
  const storedFieldSnapshot = assertRecord(snapshot.storedFields, 'storedFields')
  if (!Array.isArray(snapshot.index)) {
    throw snapshotError('index must be an array')
  }
  if (!Array.isArray(snapshot.averageFieldLength)) {
    throw snapshotError('averageFieldLength must be an array')
  }

  const snapshotFieldNames = Object.keys(snapshot.fieldIds)
  const fields = options.fields?.length ? options.fields : snapshotFieldNames
  if (options.fields?.length) {
    assertFieldsMatchSnapshot(fields, snapshot.fieldIds)
  }
  const opts = resolveIndexingOptions({ ...options, fields })

  const fieldCount = opts.fields.length
  const documentCount = assertNonNegativeInteger(snapshot.documentCount, 'documentCount')
  const nextId = assertNonNegativeInteger(snapshot.nextId, 'nextId')
  if (documentCount > nextId) {
    throw snapshotError(`documentCount ${documentCount} must be <= nextId ${nextId}`)
  }
  const fieldIds = validateFieldIds(rawFieldIds, fieldCount)
  const activeShortIds = validateActiveShortIds(documentIds, documentCount, nextId)
  const activeShortIdSet = new Set(activeShortIds)
  for (const shortIdStr of Object.keys(storedFieldSnapshot)) {
    const shortId = parseIntegerKey(shortIdStr, 'storedFields')
    assertShortIdInRange(shortId, nextId, 'storedFields')
    if (!activeShortIdSet.has(shortId)) {
      throw snapshotError(`storedFields shortId ${shortId} is missing from documentIds`)
    }
  }
  for (const [shortIdStr, lengths] of Object.entries(fieldLength)) {
    const shortId = parseIntegerKey(shortIdStr, 'fieldLength')
    assertShortIdInRange(shortId, nextId, 'fieldLength')
    if (!activeShortIdSet.has(shortId)) {
      throw snapshotError(`fieldLength shortId ${shortId} is missing from documentIds`)
    }
    if (!Array.isArray(lengths)) {
      throw snapshotError(`fieldLength shortId ${shortId} must be an array`)
    }
    for (let f = 0; f < fieldCount; f++) {
      const length = lengths[f] ?? 0
      if (!Number.isFinite(length) || length < 0) {
        throw snapshotError(`fieldLength shortId ${shortId} field ${f} must be a non-negative number`)
      }
    }
  }
  for (const shortId of activeShortIds) {
    if (!Object.prototype.hasOwnProperty.call(fieldLength, String(shortId))) {
      throw snapshotError(`fieldLength missing shortId ${shortId}`)
    }
  }
  if (snapshot.averageFieldLength.length !== fieldCount) {
    throw snapshotError(`averageFieldLength length must equal field count ${fieldCount}`)
  }
  for (let f = 0; f < fieldCount; f++) {
    const avg = snapshot.averageFieldLength[f]
    if (!Number.isFinite(avg) || avg < 0) {
      throw snapshotError(`averageFieldLength field ${f} must be a non-negative number`)
    }
  }
  const useDense = documentCount < nextId

  let shortIdRemap: Uint32Array | null = null
  const resolvedNextId = useDense ? documentCount : nextId
  const externalIds: unknown[] = new Array(resolvedNextId)
  const storedFieldRows: (Record<string, unknown> | undefined)[] = new Array(externalIds.length)

  if (useDense) {
    shortIdRemap = new Uint32Array(nextId)
    shortIdRemap.fill(DISCARDED_DOC_ID)
    let dense = 0
    const sortedShortIds = [...activeShortIds].sort((a, b) => a - b)
    for (const shortId of sortedShortIds) {
      const shortIdStr = String(shortId)
      shortIdRemap[shortId] = dense
      externalIds[dense] = documentIds[shortIdStr]
      storedFieldRows[dense] = storedFieldSnapshot[shortIdStr] as Record<string, unknown> | undefined
      dense++
    }
  } else {
    for (const [shortIdStr, id] of Object.entries(documentIds)) {
      const shortId = parseIntegerKey(shortIdStr, 'documentIds')
      externalIds[shortId] = id
      storedFieldRows[shortId] = storedFieldSnapshot[shortIdStr] as Record<string, unknown> | undefined
    }
  }

  const idLookup = createIdToShortIdLookup(externalIds, resolvedNextId)

  const matrixRows = useDense ? documentCount : nextId
  const matrixCells = matrixRows * fieldCount
  const fieldLengthScratch: number[] = new Array(matrixCells).fill(0)
  for (const [shortIdStr, lengths] of Object.entries(fieldLength)) {
    const shortId = parseIntegerKey(shortIdStr, 'fieldLength')
    const row = shortIdRemap != null ? shortIdRemap[shortId] : shortId
    if (row === DISCARDED_DOC_ID) continue
    for (let f = 0; f < fieldCount; f++) {
      fieldLengthScratch[row * fieldCount + f] = (lengths as number[])[f] ?? 0
    }
  }
  const fieldLengthMatrix = materializeFieldLengthMatrix(fieldLengthScratch)

  const avgFieldLength = new Float32Array(snapshot.averageFieldLength.length)
  for (let i = 0; i < snapshot.averageFieldLength.length; i++) {
    avgFieldLength[i] = snapshot.averageFieldLength[i]
  }

  const searchableMap = buildSearchableMapFromSnapshot(snapshot, fieldCount, nextId)
  const flat = buildFlatPostingsFromSearchableMap(
    searchableMap,
    fieldCount,
    resolvedNextId,
    shortIdRemap,
  )

  const storedFields = storedFieldsFromRows(storedFieldRows, opts.storeFields)

  return {
    options: opts,
    documentCount,
    nextId: resolvedNextId,
    fieldIds,
    fieldCount,
    externalIds,
    idLookup,
    storedFields,
    fieldLengthMatrix,
    avgFieldLength,
    index: flat.index,
    termCount: flat.termCount,
    postings: flat.postings,
  }
}
