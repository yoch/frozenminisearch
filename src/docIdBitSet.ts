import type { DocIdGate } from './scoring'

function popcount(word: number): number {
  word -= (word >>> 1) & 0x55555555
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333)
  return Math.imul((word + (word >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24
}

/**
 * Short doc ids below a fixed limit, one bit each. Iteration is in ascending id
 * order, from an array cached until the next change, so a set used as a gate is
 * listed once however many terms iterate it.
 */
export class DocIdBitSet implements DocIdGate {
  size = 0
  private readonly _limit: number
  private readonly _words: Uint32Array
  private _ids: Uint32Array | undefined

  constructor(docIdLimit: number) {
    this._limit = docIdLimit
    this._words = new Uint32Array((docIdLimit + 31) >>> 5)
  }

  has(docId: number): boolean {
    return (this._words[docId >>> 5] & (1 << (docId & 31))) !== 0
  }

  add(docId: number): this {
    if (!(docId >= 0 && docId < this._limit)) throw new RangeError(`FrozenMiniSearch: doc id ${docId} out of range`)
    const word = docId >>> 5
    const bit = 1 << (docId & 31)
    if ((this._words[word] & bit) === 0) {
      this._words[word] |= bit
      this.size++
      this._ids = undefined
    }
    return this
  }

  delete(docId: number): boolean {
    const word = docId >>> 5
    const bit = 1 << (docId & 31)
    if ((this._words[word] & bit) === 0) return false
    this._words[word] &= ~bit
    this.size--
    this._ids = undefined
    return true
  }

  /** Adds every id of `other`, a set with the same limit. */
  or(other: DocIdBitSet): void {
    this._combine(other, (a, b) => a | b)
  }

  /** Keeps only the ids also in `other`, a set with the same limit. */
  and(other: DocIdBitSet): void {
    this._combine(other, (a, b) => a & b)
  }

  /** Removes every id of `other`, a set with the same limit. */
  andNot(other: DocIdBitSet): void {
    this._combine(other, (a, b) => a & ~b)
  }

  private _combine(other: DocIdBitSet, op: (a: number, b: number) => number): void {
    const words = this._words
    const otherWords = other._words
    let size = 0
    for (let i = 0; i < words.length; i++) {
      const word = op(words[i], otherWords[i])
      words[i] = word
      size += popcount(word)
    }
    this.size = size
    this._ids = undefined
  }

  /** Ids in ascending order. The array is shared until the next change; do not mutate it. */
  toArray(): Uint32Array {
    if (this._ids !== undefined) return this._ids
    const ids = new Uint32Array(this.size)
    const words = this._words
    let write = 0
    for (let word = 0; write < ids.length; word++) {
      let bits = words[word]
      while (bits !== 0) {
        const lowest = bits & -bits
        ids[write++] = (word << 5) + 31 - Math.clz32(lowest)
        bits ^= lowest
      }
    }
    this._ids = ids
    return ids
  }

  [Symbol.iterator](): Iterator<number> {
    return this.toArray()[Symbol.iterator]()
  }
}
