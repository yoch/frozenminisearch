import { packedIndexArray } from './PackedRadixTree/layout'
import type { PackedIndexArray } from './PackedRadixTree/types'

/** Same adaptive unsigned width as {@link PackedIndexArray} / {@link packedIndexArray}. */
export type FieldLengthArray = PackedIndexArray

export function maxInArrayLike(data: ArrayLike<number>, length?: number): number {
  const len = length ?? data.length
  let max = 0
  for (let i = 0; i < len; i++) {
    const v = data[i] ?? 0
    if (v > max) max = v
  }
  return max
}

export function allocateFieldLengthMatrix(length: number, maxValue: number): FieldLengthArray {
  return packedIndexArray(length, maxValue)
}

export function materializeFieldLengthMatrix(data: ArrayLike<number>, length?: number): FieldLengthArray {
  const len = length ?? data.length
  const matrix = packedIndexArray(len, maxInArrayLike(data, len))
  for (let i = 0; i < len; i++) {
    matrix[i] = data[i] ?? 0
  }
  return matrix
}

/**
 * MSv3/MSv4 wire format always stores field length cells as Uint32.
 * {@link FrozenMiniSearch.loadBinary} materializes the same width, so adaptive
 * in-memory savings (Uint8/Uint16) are not preserved after a binary round-trip.
 */
export function fieldLengthMatrixForWire(matrix: FieldLengthArray): Uint32Array {
  if (matrix instanceof Uint32Array) return matrix
  const out = new Uint32Array(matrix.length)
  for (let i = 0; i < matrix.length; i++) out[i] = matrix[i]
  return out
}
