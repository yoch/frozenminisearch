import type { FieldTermDataLike, PostingListLike } from './scoring'

const MAX_FREQ_UINT8 = 255

/** View into global flat posting buffers (no per-list allocation). */
export class SegmentPostingList implements PostingListLike {
  private readonly _docIds: Uint32Array
  private readonly _freqs: Uint8Array
  private readonly _offset: number
  private readonly _length: number

  constructor(docIds: Uint32Array, freqs: Uint8Array, offset: number, length: number) {
    this._docIds = docIds
    this._freqs = freqs
    this._offset = offset
    this._length = length
  }

  get size(): number {
    return this._length
  }

  forEachDoc(callback: (docId: number, termFreq: number) => void): void {
    const { _docIds, _freqs, _offset, _length } = this
    for (let i = 0; i < _length; i++) {
      callback(_docIds[_offset + i], _freqs[_offset + i])
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

export function flatFieldTermData(
  termIndex: number,
  fieldCount: number,
  postingsOffsets: Uint32Array,
  postingsLengths: Uint32Array,
  allDocIds: Uint32Array,
  allFreqs: Uint8Array,
): FieldTermDataLike {
  const base = termIndex * fieldCount
  return {
    get(fieldId: number) {
      const len = postingsLengths[base + fieldId]
      if (len === 0) return undefined
      const off = postingsOffsets[base + fieldId]
      return new SegmentPostingList(allDocIds, allFreqs, off, len)
    },
  }
}
