import type { FieldTermDataLike, PostingListLike } from './scoring'

/** Compact posting list: parallel sorted docIds and freqs */
export class CompactPostingList implements PostingListLike {
  readonly docIds: Uint32Array
  readonly freqs: Uint8Array | Uint16Array | Uint32Array

  constructor (docIds: Uint32Array, freqs: Uint8Array | Uint16Array | Uint32Array) {
    this.docIds = docIds
    this.freqs = freqs
  }

  get size (): number {
    return this.docIds.length
  }

  forEachDoc (callback: (docId: number, termFreq: number) => void): void {
    const { docIds, freqs } = this
    for (let i = 0; i < docIds.length; i++) {
      callback(docIds[i], freqs[i])
    }
  }
}

export type CompactFieldTermData = {
  /** Per fieldId: compact list or undefined */
  byField: (CompactPostingList | undefined)[]
  /** fieldId -> matching document count (= posting list size) */
  matchingFieldsByField: Uint32Array
}

export function compactFieldTermDataAdapter (data: CompactFieldTermData): FieldTermDataLike {
  return {
    get (fieldId) {
      return data.byField[fieldId]
    }
  }
}

/** Pick smallest TypedArray type that fits all frequencies */
export function freqsTypedArray (values: number[]): Uint8Array | Uint16Array | Uint32Array {
  let max = 0
  for (const v of values) {
    if (v > max) max = v
  }
  if (max <= 255) {
    const arr = new Uint8Array(values.length)
    for (let i = 0; i < values.length; i++) arr[i] = values[i]
    return arr
  }
  if (max <= 65535) {
    const arr = new Uint16Array(values.length)
    for (let i = 0; i < values.length; i++) arr[i] = values[i]
    return arr
  }
  const arr = new Uint32Array(values.length)
  for (let i = 0; i < values.length; i++) arr[i] = values[i]
  return arr
}

/** Build compact posting from Map<shortId, freq> (keys should be sorted ascending) */
export function compactPostingFromMap (freqs: Map<number, number>): CompactPostingList {
  const n = freqs.size
  const docIds = new Uint32Array(n)
  const freqValues: number[] = new Array(n)
  let i = 0
  for (const [docId, freq] of freqs) {
    docIds[i] = docId
    freqValues[i] = freq
    i++
  }
  return new CompactPostingList(docIds, freqsTypedArray(freqValues))
}
