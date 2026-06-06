import type { PostingListLike } from './scoring'

export const MAX_FREQ = 65535

export type DocIdArray = Uint16Array | Uint32Array

/** Adaptive-width unsigned column for term frequencies (u8 or u16; never u32). */
export type FreqArray = Uint8Array | Uint16Array

export function readDocId(docIds: DocIdArray, index: number): number {
  return docIds[index] as number
}

export function allocateFreqs(length: number, maxValue: number): FreqArray {
  if (maxValue <= 0xff) return new Uint8Array(length)
  return new Uint16Array(length)
}

/**
 * Clamp term frequency for frozen flat storage (max Uint16).
 * Values above {@link MAX_FREQ} are rare; BM25+ contribution is already flat well below that.
 */
export function clampFreq(freq: number): number {
  return freq > MAX_FREQ ? MAX_FREQ : freq
}

/** View into global flat posting buffers (no per-list allocation). */
export class SegmentPostingList implements PostingListLike {
  readonly docIds: DocIdArray
  readonly freqs: FreqArray
  private _offset: number
  private _length: number

  constructor(docIds: DocIdArray, freqs: FreqArray, offset: number, length: number) {
    this.docIds = docIds
    this.freqs = freqs
    this._offset = offset
    this._length = length
  }

  get offset(): number {
    return this._offset
  }

  get length(): number {
    return this._length
  }

  /** Rebind this view to another segment in the same global buffers (flyweight use). */
  rebind(offset: number, length: number): this {
    this._offset = offset
    this._length = length
    return this
  }

  get size(): number {
    return this._length
  }

  forEachDoc(callback: (docId: number, termFreq: number) => void): void {
    const { docIds, freqs, offset, length } = this
    for (let i = 0; i < length; i++) {
      callback(readDocId(docIds, offset + i), freqs[offset + i])
    }
  }
}
