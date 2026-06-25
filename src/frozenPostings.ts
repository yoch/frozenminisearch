import {
  allocateFreqs,
  findDocIndexInSortedSegment,
  readDocId,
  SegmentPostingList,
  shouldSeekAllowedDocs,
  type DocIdArray,
  type FreqArray,
} from './compactPostings'
import type { AggregateContext, DocIdGate, FieldBoostsForQuery, FieldTermDataLike } from './scoring'
import {
  DISCARDED_DOC_ID,
  postingFreqValue,
  type FlatPostingsMaterializeParams,
} from './flatPostings'

export type { DocIdArray } from './compactPostings'

export type FieldIdArray = Uint8Array | Uint16Array

export function readFieldId(fieldIds: FieldIdArray, index: number): number {
  return fieldIds[index] as number
}

export type PostingsLayoutKind = 'dense' | 'sparse'

export interface FrozenPostingsLayoutBase {
  fieldCount: number
  termCount: number
  nextId: number
  docIdWidth: 16 | 32
  allDocIds: DocIdArray
  allFreqs: FreqArray
}

export interface DensePostingsLayout extends FrozenPostingsLayoutBase {
  layout: 'dense'
  denseOffsets: Uint32Array
  denseLengths: Uint32Array
}

export interface SparsePostingsLayout extends FrozenPostingsLayoutBase {
  layout: 'sparse'
  sparseFieldIdWidth: 8 | 16
  sparseTermStarts: Uint32Array
  sparseFieldIds: FieldIdArray
  sparseOffsets: Uint32Array
  sparseLengths: Uint32Array
}

export type FrozenPostingsLayout = DensePostingsLayout | SparsePostingsLayout

export function chooseSparseFieldIdWidth(fieldCount: number): 8 | 16 {
  return fieldCount > 255 ? 16 : 8
}

export function choosePostingsLayout(
  fieldCount: number,
  termCount: number,
  nonEmptySlots: number,
): PostingsLayoutKind {
  const denseBytes = termCount * fieldCount * 8
  const sparseFieldIdBytes = chooseSparseFieldIdWidth(fieldCount) === 16 ? 2 : 1
  const sparseBytes = (termCount + 1) * 4 + nonEmptySlots * (sparseFieldIdBytes + 8)
  return denseBytes <= sparseBytes ? 'dense' : 'sparse'
}

export interface PostingsSlotTargets {
  allDocIds: DocIdArray
  allFreqs: FreqArray
  docIdWidth: 16 | 32
}

/** Slot source for {@link buildFrozenPostingsLayout} (callback or incremental paths). */
export interface PostingsSlotSource {
  readonly nonEmptySlots: number
  slotLength(termIndex: number, fieldId: number): number
  writeSlot(
    termIndex: number,
    fieldId: number,
    writeOffset: number,
    targets: PostingsSlotTargets,
  ): number
}

/** Shared dense/sparse layout emission; callers supply per-slot length and copy. */
export function buildFrozenPostingsLayout(
  fieldCount: number,
  termCount: number,
  nextId: number,
  totalPostings: number,
  maxFreq: number,
  source: PostingsSlotSource,
): FrozenPostingsLayout {
  const layout = choosePostingsLayout(fieldCount, termCount, source.nonEmptySlots)
  const docIdWidth: 16 | 32 = nextId <= 65535 ? 16 : 32
  const allDocIds: DocIdArray = docIdWidth === 16
    ? new Uint16Array(totalPostings)
    : new Uint32Array(totalPostings)
  const allFreqs = allocateFreqs(totalPostings, maxFreq)
  const targets: PostingsSlotTargets = { allDocIds, allFreqs, docIdWidth }

  if (layout === 'dense') {
    const slotCount = termCount * fieldCount
    const denseOffsets = new Uint32Array(slotCount)
    const denseLengths = new Uint32Array(slotCount)
    let write = 0
    for (let ti = 0; ti < termCount; ti++) {
      const base = ti * fieldCount
      for (let f = 0; f < fieldCount; f++) {
        const slot = base + f
        const len = source.slotLength(ti, f)
        denseOffsets[slot] = write
        denseLengths[slot] = len
        if (len > 0) {
          write = source.writeSlot(ti, f, write, targets)
        }
      }
    }
    return {
      fieldCount,
      termCount,
      nextId,
      layout: 'dense',
      docIdWidth,
      allDocIds,
      allFreqs,
      denseOffsets,
      denseLengths,
    }
  }

  const sparseFieldIdWidth = chooseSparseFieldIdWidth(fieldCount)
  const sparseFieldIdsScratch: number[] = []
  const sparseOffsets: number[] = []
  const sparseLengths: number[] = []
  const termStarts: number[] = new Array(termCount + 1).fill(0)
  let write = 0

  for (let ti = 0; ti < termCount; ti++) {
    termStarts[ti] = sparseFieldIdsScratch.length
    for (let f = 0; f < fieldCount; f++) {
      const len = source.slotLength(ti, f)
      if (len === 0) continue
      sparseFieldIdsScratch.push(f)
      sparseOffsets.push(write)
      sparseLengths.push(len)
      write = source.writeSlot(ti, f, write, targets)
    }
    termStarts[ti + 1] = sparseFieldIdsScratch.length
  }

  const sparseFieldIds: FieldIdArray = sparseFieldIdWidth === 16
    ? new Uint16Array(sparseFieldIdsScratch)
    : new Uint8Array(sparseFieldIdsScratch)

  return {
    fieldCount,
    termCount,
    nextId,
    layout: 'sparse',
    docIdWidth,
    sparseFieldIdWidth,
    allDocIds,
    allFreqs,
    sparseTermStarts: new Uint32Array(termStarts),
    sparseFieldIds,
    sparseOffsets: new Uint32Array(sparseOffsets),
    sparseLengths: new Uint32Array(sparseLengths),
  }
}

export function materializeFrozenPostings(
  params: FlatPostingsMaterializeParams & { nextId: number },
): FrozenPostingsLayout {
  const { fieldCount, termCount, nextId } = params
  const { forEachPosting, remapDocId, clampFrequencies } = params
  const slotCount = termCount * fieldCount
  const slotLengths = new Uint32Array(slotCount)

  let totalPostings = 0
  let maxFreq = 0
  let nonEmptySlots = 0
  for (let ti = 0; ti < termCount; ti++) {
    const base = ti * fieldCount
    for (let f = 0; f < fieldCount; f++) {
      let count = 0
      forEachPosting(ti, f, (rawDocId, freq) => {
        const docId = remapDocId != null ? remapDocId(rawDocId) : rawDocId
        if (docId === DISCARDED_DOC_ID) return
        count++
        const v = postingFreqValue(freq, clampFrequencies)
        if (v > maxFreq) maxFreq = v
      })
      if (count === 0) continue
      slotLengths[base + f] = count
      totalPostings += count
      nonEmptySlots++
    }
  }

  return buildFrozenPostingsLayout(
    fieldCount,
    termCount,
    nextId,
    totalPostings,
    maxFreq,
    {
      nonEmptySlots,
      slotLength(ti, f) {
        return slotLengths[ti * fieldCount + f]
      },
      writeSlot(ti, f, write, targets) {
        const { allDocIds: outDocIds, allFreqs: outFreqs, docIdWidth: width } = targets
        forEachPosting(ti, f, (rawDocId, freq) => {
          const docId = remapDocId != null ? remapDocId(rawDocId) : rawDocId
          if (docId === DISCARDED_DOC_ID) return
          if (width === 16) {
            (outDocIds as Uint16Array)[write] = docId
          } else {
            (outDocIds as Uint32Array)[write] = docId
          }
          outFreqs[write] = postingFreqValue(freq, clampFrequencies)
          write++
        })
        return write
      },
    },
  )
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
    const offsetsBytes = layout.denseOffsets.byteLength
    const lengthsBytes = layout.denseLengths.byteLength
    return {
      allDocIdsBytes,
      allFreqsBytes,
      offsetsBytes,
      lengthsBytes,
      totalTypedBytes: allDocIdsBytes + allFreqsBytes + offsetsBytes + lengthsBytes,
      slotCount: layout.termCount * layout.fieldCount,
    }
  }

  const offsetsBytes = layout.sparseOffsets.byteLength + layout.sparseTermStarts.byteLength
  const lengthsBytes = layout.sparseLengths.byteLength + layout.sparseFieldIds.byteLength
  const slotCount = layout.sparseFieldIds.length
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
  fail: (detail: string) => never = (detail) => { throw new Error(detail) },
): void {
  if (layout.fieldCount <= 0) fail('fieldCount must be positive')
  if (layout.nextId !== nextId) fail('nextId mismatch')
  if (layout.termCount < 0) fail('termCount out of range')
  if (layout.allDocIds.length !== layout.allFreqs.length) {
    fail('allDocIds and allFreqs length mismatch')
  }
  if (layout.layout === 'dense') {
    const slotCount = layout.termCount * layout.fieldCount
    if (layout.denseOffsets.length !== slotCount || layout.denseLengths.length !== slotCount) {
      fail('dense postings slot count mismatch')
    }
    for (let slot = 0; slot < slotCount; slot++) {
      const off = layout.denseOffsets[slot]
      const len = layout.denseLengths[slot]
      if (off + len > layout.allDocIds.length) {
        fail(`posting slot ${slot} exceeds allDocIds bounds`)
      }
      for (let i = 0; i < len; i++) {
        const docId = readDocId(layout.allDocIds, off + i)
        if (docId >= nextId) fail(`posting docId ${docId} >= nextId ${nextId}`)
      }
    }
  } else if (layout.layout === 'sparse') {
    const expectedFieldIdWidth = chooseSparseFieldIdWidth(layout.fieldCount)
    if (layout.sparseFieldIdWidth !== expectedFieldIdWidth) {
      fail('sparseFieldIdWidth mismatch with fieldCount')
    }

    const starts = layout.sparseTermStarts
    if (starts.length !== layout.termCount + 1) fail('sparseTermStarts length mismatch')
    const slotCount = layout.sparseFieldIds.length
    if (layout.sparseOffsets.length !== slotCount || layout.sparseLengths.length !== slotCount) {
      fail('sparse slot count mismatch')
    }
    for (let slot = 0; slot < slotCount; slot++) {
      const fieldId = readFieldId(layout.sparseFieldIds, slot)
      if (fieldId >= layout.fieldCount) {
        fail(`sparse fieldId ${fieldId} >= fieldCount ${layout.fieldCount}`)
      }
      const off = layout.sparseOffsets[slot]
      const len = layout.sparseLengths[slot]
      if (off + len > layout.allDocIds.length) {
        fail(`sparse slot ${slot} exceeds allDocIds bounds`)
      }
      for (let i = 0; i < len; i++) {
        const docId = readDocId(layout.allDocIds, off + i)
        if (docId >= nextId) fail(`posting docId ${docId} >= nextId ${nextId}`)
      }
    }
  } else {
    const _exhaustive: never = layout
    fail(`unknown postings layout: ${(_exhaustive as FrozenPostingsLayout).layout}`)
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

/**
 * Module-level scratch for {@link resolvePostingSlice} (zero allocation on hot paths).
 *
 * **Threading / reentrancy:** query execution is synchronous and single-threaded today.
 * Safe while `search()` does not yield and callers do not re-enter the engine from
 * callbacks (`filter`, `boostDocument`, `isDocActive`) on the same index instance.
 * If the engine becomes async, concurrent, or shared across Workers without copying
 * the index, pass a per-query scratch (or move scratch onto the flyweight instance).
 */
const postingSliceScratch = { offset: 0, length: 0 }

/**
 * Resolve one (termIndex, fieldId) posting run in flat buffers; writes into `out` without allocating.
 * @returns false when the slot is empty or missing
 */
function resolvePostingSlice(
  layout: FrozenPostingsLayout,
  termIndex: number,
  fieldId: number,
  out: { offset: number, length: number },
): boolean {
  if (layout.layout === 'dense') {
    const base = termIndex * layout.fieldCount + fieldId
    const len = layout.denseLengths[base]
    if (len === 0) return false
    out.offset = layout.denseOffsets[base]
    out.length = len
    return true
  }

  if (layout.layout === 'sparse') {
    const start = layout.sparseTermStarts[termIndex]
    const end = layout.sparseTermStarts[termIndex + 1]
    const slot = findSparseSlotByFieldId(layout.sparseFieldIds, start, end, fieldId)
    if (slot < 0) return false
    const len = layout.sparseLengths[slot]
    if (len === 0) return false
    out.offset = layout.sparseOffsets[slot]
    out.length = len
    return true
  }

  const _exhaustive: never = layout
  return _exhaustive
}

/** Single rebindable {@link FieldTermDataLike} per frozen index (O(1) RAM). */
export type FrozenFieldTermFlyweight = FieldTermDataLike & {
  bind(termIndex: number): FrozenFieldTermFlyweight
}

/**
 * One flyweight wrapper for the lifetime of a frozen index. Call {@link bind} before each
 * `get`; the returned object is always the same instance (valid until the next `bind`).
 */
export function createFrozenFieldTermFlyweight(layout: FrozenPostingsLayout): FrozenFieldTermFlyweight {
  let termIndex = -1
  const { allDocIds, allFreqs } = layout
  const segment = new SegmentPostingList(allDocIds, allFreqs, 0, 0)

  const flyweight: FrozenFieldTermFlyweight = {
    bind(ti: number) {
      termIndex = ti
      return flyweight
    },
    get(fieldId: number) {
      if (!resolvePostingSlice(layout, termIndex, fieldId, postingSliceScratch)) return undefined
      return segment.rebind(postingSliceScratch.offset, postingSliceScratch.length)
    },
  }
  return flyweight
}

function collectDocIdsFromFrozenSegment(
  allDocIds: DocIdArray,
  offset: number,
  length: number,
  context: AggregateContext,
  docIds: Set<number>,
  allowedDocs?: DocIdGate,
): void {
  if (allowedDocs != null && shouldSeekAllowedDocs(allowedDocs.size, length)) {
    for (const docId of allowedDocs) {
      if (context.isDocActive != null && !context.isDocActive(docId)) continue
      if (findDocIndexInSortedSegment(allDocIds, offset, length, docId) >= 0) {
        docIds.add(docId)
      }
    }
    return
  }

  for (let i = 0; i < length; i++) {
    const docId = readDocId(allDocIds, offset + i)
    if (context.isDocActive != null && !context.isDocActive(docId)) continue
    if (allowedDocs != null && !allowedDocs.has(docId)) continue
    docIds.add(docId)
  }
}

/** Collect docIds from flat postings without {@link FieldTermDataLike} wrappers. */
export function collectDocIdsFromFrozenLayout(
  layout: FrozenPostingsLayout,
  termIndex: number,
  fieldBoosts: FieldBoostsForQuery,
  context: AggregateContext,
  docIds: Set<number>,
  allowedDocs?: DocIdGate,
): void {
  const { fieldIds } = context

  for (const field of fieldBoosts.names) {
    if (!resolvePostingSlice(layout, termIndex, fieldIds[field], postingSliceScratch)) continue
    collectDocIdsFromFrozenSegment(
      layout.allDocIds,
      postingSliceScratch.offset,
      postingSliceScratch.length,
      context,
      docIds,
      allowedDocs,
    )
  }
}
