import { forEachLiveShortId } from './forEachLiveShortId'
import type { FrozenFieldTermFlyweight } from './frozenPostings'
import type { FrozenAssembleParams } from './frozenTypes'
import type { MiniSearchSnapshot, SerializedIndexEntry } from './fromMiniSearch'
import { readStoredFields } from './storedFieldsLayout'

type MiniSearchSnapshotFromFrozenInput = Pick<
  FrozenAssembleParams,
  | 'documentCount'
  | 'nextId'
  | 'fieldIds'
  | 'fieldCount'
  | 'externalIds'
  | 'fieldLengthMatrix'
  | 'avgFieldLength'
  | 'storedFields'
  | 'index'
> & { fieldTermFlyweight: FrozenFieldTermFlyweight }

/**
 * Build a MiniSearch `toJSON` wire snapshot (`serializationVersion: 2`) from frozen index parts.
 * Alloc-heavy (plain objects per term/field) — migration/interop only, not production persistence.
 * All input parts must belong to the same frozen index instance.
 */
export function miniSearchSnapshotFromFrozen(
  input: MiniSearchSnapshotFromFrozenInput,
): MiniSearchSnapshot {
  const {
    documentCount,
    nextId,
    fieldIds,
    fieldCount,
    externalIds,
    fieldLengthMatrix,
    avgFieldLength,
    storedFields,
    index,
    fieldTermFlyweight,
  } = input

  const documentIds: MiniSearchSnapshot['documentIds'] = {}
  const fieldLength: MiniSearchSnapshot['fieldLength'] = {}
  const storedFieldsOut: MiniSearchSnapshot['storedFields'] = {}
  const hasStoredFields = storedFields.kind !== 'none'

  forEachLiveShortId(nextId, externalIds, (shortId, externalId) => {
    const shortIdStr = String(shortId)
    documentIds[shortIdStr] = externalId

    const lengths = new Array<number>(fieldCount)
    const rowBase = shortId * fieldCount
    for (let f = 0; f < fieldCount; f++) {
      lengths[f] = fieldLengthMatrix[rowBase + f] ?? 0
    }
    fieldLength[shortIdStr] = lengths

    if (hasStoredFields) {
      storedFieldsOut[shortIdStr] = readStoredFields(storedFields, shortId)
    }
  })

  const indexEntries: MiniSearchSnapshot['index'] = []

  for (const [term, termIndex] of index.entries()) {
    fieldTermFlyweight.bind(termIndex)
    const fieldData: { [fieldId: string]: SerializedIndexEntry } = {}

    for (let f = 0; f < fieldCount; f++) {
      const segment = fieldTermFlyweight.get(f)
      if (segment == null || segment.size === 0) continue

      const entry: SerializedIndexEntry = {}
      segment.forEachDoc((docId, freq) => {
        entry[String(docId)] = freq
      })
      fieldData[String(f)] = entry
    }

    if (Object.keys(fieldData).length > 0) {
      indexEntries.push([term, fieldData])
    }
  }

  return {
    documentCount,
    nextId,
    documentIds,
    fieldIds,
    fieldLength,
    averageFieldLength: Array.from(avgFieldLength),
    storedFields: storedFieldsOut,
    dirtCount: 0,
    index: indexEntries,
    serializationVersion: 2,
  }
}
