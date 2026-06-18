import type { PostingListLike } from './scoring'
import {
  DEFAULT_POSTING_GATE_MIN_LENGTH,
  passGateByPostingRatio,
} from './queryEngineGateLimits'

export const MAX_FREQ = 65535

export type DocIdArray = Uint16Array | Uint32Array

/** Adaptive-width unsigned column for term frequencies (u8 or u16; never u32). */
export type FreqArray = Uint8Array | Uint16Array

export function readDocId(docIds: DocIdArray, index: number): number {
  return docIds[index] as number
}

/** @deprecated Use {@link DEFAULT_POSTING_GATE_MIN_LENGTH} — seek shares numeric thresholds with AND gate ratio policy. */
export const SEEK_ALLOWED_MIN_LIST_LENGTH = DEFAULT_POSTING_GATE_MIN_LENGTH

/** Binary search for docId in a sorted segment; returns global index or -1. */
export function findDocIndexInSortedSegment(
  docIds: DocIdArray,
  offset: number,
  length: number,
  docId: number,
): number {
  let lo = 0
  let hi = length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const v = readDocId(docIds, offset + mid)
    if (v < docId) lo = mid + 1
    else if (v > docId) hi = mid - 1
    else return offset + mid
  }
  return -1
}

/**
 * Scan vs binary search once `allowedDocs` is already in effect (scoring layer).
 * Uses the same numeric policy as {@link passGateByPostingRatio} today; distinct decision point.
 */
export function shouldSeekAllowedDocs(gateSize: number, listLength: number): boolean {
  return passGateByPostingRatio(gateSize, listLength)
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
