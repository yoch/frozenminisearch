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
  /** Apply frequency clamp at {@link MAX_FREQ} (frozen paths). */
  clampFrequencies?: boolean
  /** Use Uint16 doc ids when all doc ids fit (requires nextId). */
  nextId?: number
}

export function postingFreqValue(freq: number, clampFrequencies: boolean | undefined): number {
  return clampFrequencies ? clampFreq(freq) : freq
}
