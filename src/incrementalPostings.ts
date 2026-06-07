import {
  allocateFreqs,
  clampFreq,
  type DocIdArray,
  type FreqArray,
} from './compactPostings'
import {
  choosePostingsLayout,
  chooseSparseFieldIdWidth,
  type FieldIdArray,
  type FrozenPostingsLayout,
} from './frozenPostings'

const DEFAULT_CAPACITY = 16

/** Growable unsigned 32-bit column (build scratch; narrowed to u16 at finalize when possible). */
export class GrowableUint32Column {
  private _buf: Uint32Array
  private _len = 0

  constructor(initialCapacity = DEFAULT_CAPACITY) {
    this._buf = new Uint32Array(Math.max(1, initialCapacity))
  }

  get length(): number {
    return this._len
  }

  push(value: number): void {
    if (this._len >= this._buf.length) {
      const grown = new Uint32Array(Math.max(1, this._buf.length * 2))
      grown.set(this._buf)
      this._buf = grown
    }
    this._buf[this._len++] = value
  }

  copyRangeInto(
    sourceOffset: number,
    length: number,
    target: DocIdArray,
    targetOffset: number,
    docIdWidth: 16 | 32,
  ): void {
    if (docIdWidth === 16) {
      const out = target as Uint16Array
      for (let i = 0; i < length; i++) out[targetOffset + i] = this._buf[sourceOffset + i]!
    } else {
      const out = target as Uint32Array
      for (let i = 0; i < length; i++) out[targetOffset + i] = this._buf[sourceOffset + i]!
    }
  }

  truncate(length: number): void {
    this._len = length
    if (length > 0 && length < this._buf.length) {
      this._buf = this._buf.slice(0, length)
    }
  }
}

/** Growable frequency column (u16 cells; matches frozen clamp range). */
export class GrowableFreqColumn {
  private _buf: Uint16Array
  private _len = 0

  constructor(initialCapacity = DEFAULT_CAPACITY) {
    this._buf = new Uint16Array(Math.max(1, initialCapacity))
  }

  get length(): number {
    return this._len
  }

  push(freq: number): void {
    if (this._len >= this._buf.length) {
      const grown = new Uint16Array(Math.max(1, this._buf.length * 2))
      grown.set(this._buf)
      this._buf = grown
    }
    this._buf[this._len++] = clampFreq(freq)
  }

  copyRangeInto(sourceOffset: number, length: number, target: FreqArray, targetOffset: number): void {
    for (let i = 0; i < length; i++) {
      target[targetOffset + i] = this._buf[sourceOffset + i]!
    }
  }

  truncate(length: number): void {
    this._len = length
    if (length > 0 && length < this._buf.length) {
      this._buf = this._buf.slice(0, length)
    }
  }
}

/** Contiguous or multi-range view of postings for one (term, field) slot in the global buffers. */
type SlotRanges = {
  starts: number[]
  lengths: number[]
}

export type IncrementalPostingsHints = {
  /** Initial capacity for global posting buffers. */
  estimatedTotalPostings?: number
}

/**
 * Single-pass postings accumulator for {@link FrozenIndexBuilder}.
 * One global TypedArray stream per docIds/freqs; per-slot range metadata only.
 */
export class IncrementalPostingsAccumulator {
  private readonly _fieldCount: number
  private readonly _docIds: GrowableUint32Column
  private readonly _freqs: GrowableFreqColumn
  private readonly _slots = new Map<number, SlotRanges>()
  private _totalPostings = 0
  private _maxFreq = 0

  constructor(fieldCount: number, hints?: IncrementalPostingsHints) {
    this._fieldCount = fieldCount
    const cap = Math.max(DEFAULT_CAPACITY, hints?.estimatedTotalPostings ?? 0)
    this._docIds = new GrowableUint32Column(cap)
    this._freqs = new GrowableFreqColumn(cap)
  }

  get totalPostings(): number {
    return this._totalPostings
  }

  get maxFreq(): number {
    return this._maxFreq
  }

  append(termIndex: number, fieldId: number, docId: number, freq: number): void {
    const slot = termIndex * this._fieldCount + fieldId
    const writeIdx = this._docIds.length
    this._docIds.push(docId)
    const v = clampFreq(freq)
    this._freqs.push(v)
    if (v > this._maxFreq) this._maxFreq = v
    this._totalPostings++

    let ranges = this._slots.get(slot)
    if (ranges == null) {
      ranges = { starts: [writeIdx], lengths: [1] }
      this._slots.set(slot, ranges)
      return
    }
    const last = ranges.starts.length - 1
    const end = ranges.starts[last]! + ranges.lengths[last]!
    if (end === writeIdx) {
      ranges.lengths[last]!++
    } else {
      ranges.starts.push(writeIdx)
      ranges.lengths.push(1)
    }
  }

  clear(): void {
    this._slots.clear()
    // Drop global scratch backing so finalize does not retain duplicate posting bytes.
    this._docIds.truncate(0)
    this._freqs.truncate(0)
  }

  private copySlot(
    ranges: SlotRanges,
    allDocIds: DocIdArray,
    allFreqs: FreqArray,
    write: number,
    docIdWidth: 16 | 32,
  ): number {
    for (let r = 0; r < ranges.starts.length; r++) {
      const start = ranges.starts[r]!
      const len = ranges.lengths[r]!
      this._docIds.copyRangeInto(start, len, allDocIds, write, docIdWidth)
      this._freqs.copyRangeInto(start, len, allFreqs, write)
      write += len
    }
    return write
  }

  private slotLength(ranges: SlotRanges): number {
    let n = 0
    for (let i = 0; i < ranges.lengths.length; i++) n += ranges.lengths[i]!
    return n
  }

  finalize(termCount: number, nextId: number): FrozenPostingsLayout {
    const fieldCount = this._fieldCount
    const totalPostings = this._totalPostings
    const maxFreq = this._maxFreq
    const slots = this._slots
    const layout = choosePostingsLayout(fieldCount)
    const docIdWidth: 16 | 32 = nextId <= 65535 ? 16 : 32
    const allDocIds: DocIdArray = docIdWidth === 16
      ? new Uint16Array(totalPostings)
      : new Uint32Array(totalPostings)
    const allFreqs = allocateFreqs(totalPostings, maxFreq)

    if (layout === 'dense') {
      const slotCount = termCount * fieldCount
      const denseOffsets = new Uint32Array(slotCount)
      const denseLengths = new Uint32Array(slotCount)
      let write = 0
      for (let ti = 0; ti < termCount; ti++) {
        const base = ti * fieldCount
        for (let f = 0; f < fieldCount; f++) {
          const slot = base + f
          const ranges = slots.get(slot)
          const len = ranges == null ? 0 : this.slotLength(ranges)
          denseOffsets[slot] = write
          denseLengths[slot] = len
          if (len > 0) {
            write = this.copySlot(ranges!, allDocIds, allFreqs, write, docIdWidth)
            slots.delete(slot)
          }
        }
      }
      slots.clear()
      this.clear()
      return {
        fieldCount,
        termCount,
        nextId,
        layout,
        docIdWidth,
        sparseFieldIdWidth: null,
        allDocIds,
        allFreqs,
        denseOffsets,
        denseLengths,
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
    let write = 0

    for (let ti = 0; ti < termCount; ti++) {
      termStarts[ti] = sparseFieldIdsScratch.length
      for (let f = 0; f < fieldCount; f++) {
        const slot = ti * fieldCount + f
        const ranges = slots.get(slot)
        const len = ranges == null ? 0 : this.slotLength(ranges)
        if (len === 0) continue
        sparseFieldIdsScratch.push(f)
        sparseOffsets.push(write)
        sparseLengths.push(len)
        write = this.copySlot(ranges!, allDocIds, allFreqs, write, docIdWidth)
        slots.delete(slot)
      }
      termStarts[ti + 1] = sparseFieldIdsScratch.length
    }
    slots.clear()
    this.clear()

    const sparseFieldIds: FieldIdArray = sparseFieldIdWidth === 16
      ? new Uint16Array(sparseFieldIdsScratch)
      : new Uint8Array(sparseFieldIdsScratch)

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
}
