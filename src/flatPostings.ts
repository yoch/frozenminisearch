import { allocateFreqs, clampFreq, type DocIdArray, type FreqArray } from './compactPostings'

export const DISCARDED_DOC_ID = 0xffffffff

export interface FlatPostingsMaterializeParams {
  fieldCount: number
  termCount: number
  /**
   * Emit postings for slot (termIndex, fieldId). Called once per non-empty slot.
   */
  forEachPosting: (
    termIndex: number,
    fieldId: number,
    emit: (docId: number, freq: number) => void,
  ) => void
  /** Remap short ids (dense freeze); return DISCARDED_DOC_ID to skip. */
  remapDocId?: (docId: number) => number
  /** Apply frequency clamp at {@link MAX_FREQ} (frozen paths). */
  clampFrequencies?: boolean
  /** Use Uint16 doc ids when all doc ids fit (requires nextId). */
  nextId?: number
}

export function postingFreqValue(freq: number, clampFrequencies: boolean | undefined): number {
  return clampFrequencies ? clampFreq(freq) : freq
}

export function materializeFlatPostings(params: FlatPostingsMaterializeParams): {
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: DocIdArray
  allFreqs: FreqArray
} {
  const { fieldCount, termCount, forEachPosting, remapDocId, clampFrequencies } = params
  const slotCount = termCount * fieldCount
  const postingsOffsets = new Uint32Array(slotCount)
  const postingsLengths = new Uint32Array(slotCount)

  let totalPostings = 0
  let maxFreq = 0
  for (let ti = 0; ti < termCount; ti++) {
    for (let f = 0; f < fieldCount; f++) {
      forEachPosting(ti, f, (rawDocId, freq) => {
        const docId = remapDocId != null ? remapDocId(rawDocId) : rawDocId
        if (docId === DISCARDED_DOC_ID) return
        totalPostings++
        const v = postingFreqValue(freq, clampFrequencies)
        if (v > maxFreq) maxFreq = v
      })
    }
  }

  const useUint16 = params.nextId != null && params.nextId <= 65535
  const allDocIds: DocIdArray = useUint16
    ? new Uint16Array(totalPostings)
    : new Uint32Array(totalPostings)
  const allFreqs = allocateFreqs(totalPostings, maxFreq)

  // Slots are visited in ascending fieldId (0..fieldCount-1) per term. Sparse layouts
  // rely on this ordering so field ids per term stay sorted for binary lookup.
  let write = 0
  for (let ti = 0; ti < termCount; ti++) {
    const base = ti * fieldCount
    for (let f = 0; f < fieldCount; f++) {
      const offset = write
      let count = 0
      forEachPosting(ti, f, (rawDocId, freq) => {
        const docId = remapDocId != null ? remapDocId(rawDocId) : rawDocId
        if (docId === DISCARDED_DOC_ID) return
        if (useUint16) {
          (allDocIds as Uint16Array)[write] = docId
        } else {
          (allDocIds as Uint32Array)[write] = docId
        }
        allFreqs[write] = postingFreqValue(freq, clampFrequencies)
        write++
        count++
      })
      postingsOffsets[base + f] = offset
      postingsLengths[base + f] = count
    }
  }

  return {
    postingsOffsets,
    postingsLengths,
    allDocIds,
    allFreqs,
  }
}
