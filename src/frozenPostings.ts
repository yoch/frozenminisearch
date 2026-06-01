import {
  clampFreq,
  flatFieldTermData,
  readDocId,
  SegmentPostingList,
  type DocIdArray,
} from './compactPostings'
import type { FieldTermDataLike } from './scoring'
import { DISCARDED_DOC_ID, materializeFlatPostings, type FlatPostingsMaterializeParams } from './flatPostings'

export type { DocIdArray } from './compactPostings'

export type FieldIdArray = Uint8Array | Uint16Array

export function readFieldId(fieldIds: FieldIdArray, index: number): number {
  return fieldIds[index] as number
}

export type PostingsLayoutKind = 'dense' | 'sparse'

export interface FrozenPostingsLayout {
  fieldCount: number
  termCount: number
  nextId: number
  layout: PostingsLayoutKind
  docIdWidth: 16 | 32
  /** Width of sparse field id column; null when layout is dense. */
  sparseFieldIdWidth: 8 | 16 | null
  allDocIds: DocIdArray
  allFreqs: Uint8Array
  denseOffsets: Uint32Array | null
  denseLengths: Uint32Array | null
  sparseTermStarts: Uint32Array | null
  sparseFieldIds: FieldIdArray | null
  sparseOffsets: Uint32Array | null
  sparseLengths: Uint32Array | null
}

export function choosePostingsLayout(fieldCount: number): PostingsLayoutKind {
  return fieldCount === 1 ? 'dense' : 'sparse'
}

export function chooseSparseFieldIdWidth(fieldCount: number): 8 | 16 {
  return fieldCount > 255 ? 16 : 8
}

export function materializeFrozenPostings(
  params: FlatPostingsMaterializeParams & { nextId: number },
): FrozenPostingsLayout {
  const { fieldCount, termCount, nextId } = params
  const layout = choosePostingsLayout(fieldCount)
  const docIdWidth: 16 | 32 = nextId <= 65535 ? 16 : 32

  if (layout === 'dense') {
    const flat = materializeFlatPostings({ ...params, nextId })
    return {
      fieldCount,
      termCount,
      nextId,
      layout,
      docIdWidth,
      sparseFieldIdWidth: null,
      allDocIds: flat.allDocIds,
      allFreqs: flat.allFreqs,
      denseOffsets: flat.postingsOffsets,
      denseLengths: flat.postingsLengths,
      sparseTermStarts: null,
      sparseFieldIds: null,
      sparseOffsets: null,
      sparseLengths: null,
    }
  }

  const sparseFieldIdWidth = chooseSparseFieldIdWidth(fieldCount)
  const sparseFieldIdsScratch: number[] = []
  const sparseOffsets: number[] = []
  const sparseLengths: number[] = []
  const termStarts: number[] = new Array(termCount + 1).fill(0)
  const { forEachPosting, remapDocId, clampFrequencies } = params

  // Non-empty slots per term are emitted with fieldId in ascending order (f loops 0..fieldCount-1).
  let totalPostings = 0
  for (let ti = 0; ti < termCount; ti++) {
    termStarts[ti] = sparseFieldIdsScratch.length
    for (let f = 0; f < fieldCount; f++) {
      let count = 0
      forEachPosting(ti, f, (rawDocId) => {
        const docId = remapDocId != null ? remapDocId(rawDocId) : rawDocId
        if (docId !== DISCARDED_DOC_ID) count++
      })
      if (count === 0) continue
      sparseFieldIdsScratch.push(f)
      sparseOffsets.push(totalPostings)
      sparseLengths.push(count)
      totalPostings += count
    }
    termStarts[ti + 1] = sparseFieldIdsScratch.length
  }

  const allDocIds: DocIdArray = docIdWidth === 16
    ? new Uint16Array(totalPostings)
    : new Uint32Array(totalPostings)
  const allFreqs = new Uint8Array(totalPostings)

  const sparseFieldIds: FieldIdArray = sparseFieldIdWidth === 16
    ? new Uint16Array(sparseFieldIdsScratch)
    : new Uint8Array(sparseFieldIdsScratch)

  let write = 0
  for (let ti = 0; ti < termCount; ti++) {
    const start = termStarts[ti]
    const end = termStarts[ti + 1]
    for (let s = start; s < end; s++) {
      const f = readFieldId(sparseFieldIds, s)
      forEachPosting(ti, f, (rawDocId, freq) => {
        const docId = remapDocId != null ? remapDocId(rawDocId) : rawDocId
        if (docId === DISCARDED_DOC_ID) return
        if (docIdWidth === 16) {
          (allDocIds as Uint16Array)[write] = docId
        } else {
          (allDocIds as Uint32Array)[write] = docId
        }
        allFreqs[write] = clampFrequencies ? clampFreq(freq) : freq
        write++
      })
    }
  }

  return {
    fieldCount,
    termCount,
    nextId,
    layout,
    docIdWidth,
    sparseFieldIdWidth,
    allDocIds,
    allFreqs,
    denseOffsets: null,
    denseLengths: null,
    sparseTermStarts: new Uint32Array(termStarts),
    sparseFieldIds,
    sparseOffsets: new Uint32Array(sparseOffsets),
    sparseLengths: new Uint32Array(sparseLengths),
  }
}

export function postingsTypedBytes(layout: FrozenPostingsLayout): {
  allDocIdsBytes: number
  allFreqsBytes: number
  offsetsBytes: number
  lengthsBytes: number
  totalTypedBytes: number
  slotCount: number
} {
  const allDocIdsBytes = layout.allDocIds.byteLength
  const allFreqsBytes = layout.allFreqs.byteLength
  if (layout.layout === 'dense') {
    const offsetsBytes = layout.denseOffsets!.byteLength
    const lengthsBytes = layout.denseLengths!.byteLength
    return {
      allDocIdsBytes,
      allFreqsBytes,
      offsetsBytes,
      lengthsBytes,
      totalTypedBytes: allDocIdsBytes + allFreqsBytes + offsetsBytes + lengthsBytes,
      slotCount: layout.termCount * layout.fieldCount,
    }
  }
  const offsetsBytes = layout.sparseOffsets!.byteLength + layout.sparseTermStarts!.byteLength
  const lengthsBytes = layout.sparseLengths!.byteLength + layout.sparseFieldIds!.byteLength
  const slotCount = layout.sparseFieldIds!.length
  return {
    allDocIdsBytes,
    allFreqsBytes,
    offsetsBytes,
    lengthsBytes,
    totalTypedBytes: allDocIdsBytes + allFreqsBytes + offsetsBytes + lengthsBytes,
    slotCount,
  }
}

export function validateFrozenPostingsLayout(
  layout: FrozenPostingsLayout,
  documentCount: number,
  nextId: number,
  fail: (detail: string) => never = detail => { throw new Error(detail) },
): void {
  if (layout.fieldCount <= 0) fail('fieldCount must be positive')
  if (layout.nextId !== nextId) fail('nextId mismatch')
  if (layout.termCount < 0) fail('termCount out of range')
  if (layout.allDocIds.length !== layout.allFreqs.length) {
    fail('allDocIds and allFreqs length mismatch')
  }
  if (layout.layout === 'dense') {
    if (layout.sparseFieldIdWidth != null) {
      fail('dense layout must not have sparseFieldIdWidth')
    }
    const slotCount = layout.termCount * layout.fieldCount
    if (layout.denseOffsets!.length !== slotCount || layout.denseLengths!.length !== slotCount) {
      fail('dense postings slot count mismatch')
    }
    for (let slot = 0; slot < slotCount; slot++) {
      const off = layout.denseOffsets![slot]
      const len = layout.denseLengths![slot]
      if (off + len > layout.allDocIds.length) {
        fail(`posting slot ${slot} exceeds allDocIds bounds`)
      }
      for (let i = 0; i < len; i++) {
        const docId = readDocId(layout.allDocIds, off + i)
        if (docId >= nextId) fail(`posting docId ${docId} >= nextId ${nextId}`)
      }
    }
  } else {
    const expectedFieldIdWidth = chooseSparseFieldIdWidth(layout.fieldCount)
    if (layout.sparseFieldIdWidth !== expectedFieldIdWidth) {
      fail('sparseFieldIdWidth mismatch with fieldCount')
    }

    const starts = layout.sparseTermStarts!
    if (starts.length !== layout.termCount + 1) fail('sparseTermStarts length mismatch')
    const slotCount = layout.sparseFieldIds!.length
    if (layout.sparseOffsets!.length !== slotCount || layout.sparseLengths!.length !== slotCount) {
      fail('sparse slot count mismatch')
    }
    for (let slot = 0; slot < slotCount; slot++) {
      const fieldId = readFieldId(layout.sparseFieldIds!, slot)
      if (fieldId >= layout.fieldCount) {
        fail(`sparse fieldId ${fieldId} >= fieldCount ${layout.fieldCount}`)
      }
      const off = layout.sparseOffsets![slot]
      const len = layout.sparseLengths![slot]
      if (off + len > layout.allDocIds.length) {
        fail(`sparse slot ${slot} exceeds allDocIds bounds`)
      }
      for (let i = 0; i < len; i++) {
        const docId = readDocId(layout.allDocIds, off + i)
        if (docId >= nextId) fail(`posting docId ${docId} >= nextId ${nextId}`)
      }
    }
  }

  if (documentCount < 0 || documentCount > nextId) {
    fail('documentCount inconsistent with nextId')
  }
}

/**
 * Locate the slot for `fieldId` within a term's range.
 *
 * `sparseFieldIds[start..end)` is sorted ascending (see materializeFrozenPostings),
 * and the range is short (at most `fieldCount`, usually 1-3 fields per term). A linear
 * scan with early exit beats binary search at this size: sequential access, predictable
 * branches, no per-step division. The sorted invariant only powers the early break.
 */
function findSparseSlotByFieldId(
  fieldIds: FieldIdArray,
  start: number,
  end: number,
  fieldId: number,
): number {
  for (let i = start; i < end; i++) {
    const fid = readFieldId(fieldIds, i)
    if (fid === fieldId) return i
    if (fid > fieldId) break
  }
  return -1
}

export function fieldTermDataFromLayout(
  layout: FrozenPostingsLayout,
  termIndex: number,
): FieldTermDataLike {
  if (layout.layout === 'dense') {
    return flatFieldTermData(
      termIndex,
      layout.fieldCount,
      layout.denseOffsets!,
      layout.denseLengths!,
      layout.allDocIds,
      layout.allFreqs,
    )
  }

  const starts = layout.sparseTermStarts!
  const start = starts[termIndex]
  const end = starts[termIndex + 1]
  const fieldIds = layout.sparseFieldIds!
  const offsets = layout.sparseOffsets!
  const lengths = layout.sparseLengths!

  return {
    get(fieldId: number) {
      const slot = findSparseSlotByFieldId(fieldIds, start, end, fieldId)
      if (slot < 0) return undefined
      const len = lengths[slot]
      if (len === 0) return undefined
      return new SegmentPostingList(layout.allDocIds, layout.allFreqs, offsets[slot], len)
    },
  }
}

/**
 * @deprecated MSv4 selection heuristic; {@link encodeFrozenSnapshot} always writes MSv5.
 */
export function shouldEncodeBinaryAsMSv4(postings: FrozenPostingsLayout): boolean {
  if (postings.layout === 'sparse') return true
  return postings.docIdWidth === 16
}
