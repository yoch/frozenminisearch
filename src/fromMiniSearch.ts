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
): SearchableMap<MutableFieldTermData> {
  const index = new SearchableMap<MutableFieldTermData>()
  const { index: entries, serializationVersion } = snapshot

  for (const [term, data] of entries) {
    const dataMap = new Map<number, Map<number, number>>() as MutableFieldTermData
    for (const fieldId of Object.keys(data)) {
      const raw = data[fieldId]
      const indexEntry = parseIndexEntry(raw, serializationVersion)
      const freqs = new Map<number, number>()
      for (const [docId, freq] of Object.entries(indexEntry)) {
        freqs.set(parseInt(docId, 10), freq)
      }
      dataMap.set(parseInt(fieldId, 10), freqs)
    }
    index.set(term, dataMap)
  }

  return index
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
  if (!SUPPORTED_SERIALIZATION_VERSIONS.has(snapshot.serializationVersion)) {
    throw new Error(
      `FrozenMiniSearch: unsupported MiniSearch serializationVersion ${snapshot.serializationVersion}`,
    )
  }

  const snapshotFieldNames = Object.keys(snapshot.fieldIds)
  const fields = options.fields?.length ? options.fields : snapshotFieldNames
  if (options.fields?.length) {
    assertFieldsMatchSnapshot(fields, snapshot.fieldIds)
  }
  const opts = resolveIndexingOptions({ ...options, fields })

  const fieldCount = opts.fields.length
  const { documentCount, nextId } = snapshot
  const useDense = documentCount < nextId

  let shortIdRemap: Uint32Array | null = null
  const resolvedNextId = useDense ? documentCount : nextId
  const externalIds: unknown[] = new Array(resolvedNextId)
  const storedFieldRows: (Record<string, unknown> | undefined)[] = new Array(externalIds.length)

  if (useDense) {
    shortIdRemap = new Uint32Array(nextId)
    shortIdRemap.fill(DISCARDED_DOC_ID)
    let dense = 0
    const sortedShortIds = Object.keys(snapshot.documentIds)
      .map(s => parseInt(s, 10))
      .sort((a, b) => a - b)
    for (const shortId of sortedShortIds) {
      const shortIdStr = String(shortId)
      shortIdRemap[shortId] = dense
      externalIds[dense] = snapshot.documentIds[shortIdStr]
      storedFieldRows[dense] = snapshot.storedFields[shortIdStr]
      dense++
    }
  } else {
    for (const [shortIdStr, id] of Object.entries(snapshot.documentIds)) {
      const shortId = parseInt(shortIdStr, 10)
      externalIds[shortId] = id
      storedFieldRows[shortId] = snapshot.storedFields[shortIdStr]
    }
  }

  const idLookup = createIdToShortIdLookup(externalIds, resolvedNextId)

  const matrixRows = useDense ? documentCount : nextId
  const matrixCells = matrixRows * fieldCount
  const fieldLengthScratch: number[] = new Array(matrixCells).fill(0)
  for (const [shortIdStr, lengths] of Object.entries(snapshot.fieldLength)) {
    const shortId = parseInt(shortIdStr, 10)
    const row = shortIdRemap != null ? shortIdRemap[shortId] : shortId
    if (row === DISCARDED_DOC_ID) continue
    for (let f = 0; f < fieldCount; f++) {
      fieldLengthScratch[row * fieldCount + f] = lengths[f] ?? 0
    }
  }
  const fieldLengthMatrix = materializeFieldLengthMatrix(fieldLengthScratch)

  const avgFieldLength = new Float32Array(snapshot.averageFieldLength.length)
  for (let i = 0; i < snapshot.averageFieldLength.length; i++) {
    avgFieldLength[i] = snapshot.averageFieldLength[i]
  }

  const searchableMap = buildSearchableMapFromSnapshot(snapshot)
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
    fieldIds: snapshot.fieldIds,
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
