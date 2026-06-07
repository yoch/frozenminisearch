import { invalidFrozenIndex } from './binaryIo'
import { packedIndexArray } from './PackedRadixTree/layout'
import type { PackedIndexArray } from './PackedRadixTree/types'
import { FLAG_FL_U8, FLAG_FL_U16 } from './msv5/binaryMsv5Constants'

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

/**
 * MSv5 encodes adaptive width
 * ({@link fieldLengthMatrixWireFlags}) and {@link readFieldLengthMatrixSection} restores u8/u16/u32.
 * {@link fieldLengthMatrixForWire} widens in-memory u8/u16 matrices to Uint32 for the MSv5 encoder.
 */
export function fieldLengthMatrixForWire(matrix: FieldLengthArray): Uint32Array {
  if (matrix instanceof Uint32Array) return matrix
  const out = new Uint32Array(matrix.length)
  for (let i = 0; i < matrix.length; i++) out[i] = matrix[i]
  return out
}

/** Global MSv5 flags for {@link FieldLengthArray} wire width. */
export function fieldLengthMatrixWireFlags(matrix: FieldLengthArray): number {
  if (matrix instanceof Uint8Array) return FLAG_FL_U8
  if (matrix instanceof Uint16Array) return FLAG_FL_U16
  return 0
}

export function buildFieldLengthMatrixSection(matrix: FieldLengthArray): Buffer {
  return Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength)
}

export function readFieldLengthMatrixSection(
  buf: Buffer,
  flags: number,
  cellCount: number,
): FieldLengthArray {
  if ((flags & FLAG_FL_U8) !== 0) {
    if (buf.length !== cellCount) {
      throw invalidFrozenIndex('fieldLengthMatrix u8 size mismatch')
    }
    return buf.length === 0
      ? new Uint8Array(0)
      : new Uint8Array(buf.buffer, buf.byteOffset, cellCount)
  }
  if ((flags & FLAG_FL_U16) !== 0) {
    if (buf.length !== cellCount * 2) {
      throw invalidFrozenIndex('fieldLengthMatrix u16 size mismatch')
    }
    return cellCount === 0
      ? new Uint16Array(0)
      : new Uint16Array(buf.buffer, buf.byteOffset, cellCount)
  }
  if (buf.length !== cellCount * 4) {
    throw invalidFrozenIndex('fieldLengthMatrix u32 size mismatch')
  }
  return cellCount === 0
    ? new Uint32Array(0)
    : new Uint32Array(buf.buffer, buf.byteOffset, cellCount)
}
