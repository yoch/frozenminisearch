import { clampFreq } from './compactPostings'

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
  /** Apply Uint8 frequency clamp (frozen paths). */
  clampFrequencies?: boolean
}

export function materializeFlatPostings(params: FlatPostingsMaterializeParams): {
  postingsOffsets: Uint32Array
  postingsLengths: Uint32Array
  allDocIds: Uint32Array
  allFreqs: Uint8Array
} {
  const { fieldCount, termCount, forEachPosting, remapDocId, clampFrequencies } = params
  const slotCount = termCount * fieldCount
  const postingsOffsets = new Uint32Array(slotCount)
  const postingsLengths = new Uint32Array(slotCount)
  const docScratch: number[] = []
  const freqScratch: number[] = []

  for (let ti = 0; ti < termCount; ti++) {
    const base = ti * fieldCount
    for (let f = 0; f < fieldCount; f++) {
      const offset = docScratch.length
      let count = 0
      forEachPosting(ti, f, (rawDocId, freq) => {
        const docId = remapDocId != null ? remapDocId(rawDocId) : rawDocId
        if (docId === DISCARDED_DOC_ID) return
        docScratch.push(docId)
        freqScratch.push(clampFrequencies ? clampFreq(freq) : freq)
        count++
      })
      postingsOffsets[base + f] = offset
      postingsLengths[base + f] = count
    }
  }

  return {
    postingsOffsets,
    postingsLengths,
    allDocIds: new Uint32Array(docScratch),
    allFreqs: new Uint8Array(freqScratch),
  }
}
