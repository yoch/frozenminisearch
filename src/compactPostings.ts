import type { PostingListLike } from './scoring'

const MAX_FREQ_UINT8 = 255

export type DocIdArray = Uint16Array | Uint32Array

export function readDocId(docIds: DocIdArray, index: number): number {
  return docIds[index] as number
}

/** View into global flat posting buffers (no per-list allocation). */
export class SegmentPostingList implements PostingListLike {
  readonly docIds: DocIdArray
  readonly freqs: Uint8Array
  readonly offset: number
  readonly length: number

  constructor(docIds: DocIdArray, freqs: Uint8Array, offset: number, length: number) {
    this.docIds = docIds
    this.freqs = freqs
    this.offset = offset
    this.length = length
  }

  get size(): number {
    return this.length
  }

  forEachDoc(callback: (docId: number, termFreq: number) => void): void {
    const { docIds, freqs, offset, length } = this
    for (let i = 0; i < length; i++) {
      callback(readDocId(docIds, offset + i), freqs[offset + i])
    }
  }
}

/**
 * Clamp term frequency to Uint8 for flat storage.
 * This intentionally caps tf at 255 in frozen indexes; see benchmark scenario
 * \"overflow frequencies\" to quantify the score drift for very large tf values.
 */
export function clampFreq(freq: number): number {
  return freq > MAX_FREQ_UINT8 ? MAX_FREQ_UINT8 : freq
}
