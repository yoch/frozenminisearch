import { packedIndexArray } from './PackedRadixTree/layout'
import type { PackedIndexArray } from './PackedRadixTree/types'

export {
  buildFieldLengthMatrixSection,
  fieldLengthMatrixWireFlags,
  readFieldLengthMatrixSection,
} from './fieldLengthMatrixWire'

/** Adaptive-width unsigned column (1/2/4 bytes per element) for field lengths and packed radix columns. */
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
