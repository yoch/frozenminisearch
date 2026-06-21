import { bytesFromView } from './binaryBytes'
import type { BinaryBytes } from './binaryBytes'
import { invalidFrozenIndex } from './frozenErrors'
import type { FieldLengthArray } from './fieldLengthMatrix'
import { FLAG_FL_U8, FLAG_FL_U16 } from './msv5/binaryMsv5Constants'

/** Global wire flags for {@link FieldLengthArray} width. */
export function fieldLengthMatrixWireFlags(matrix: FieldLengthArray): number {
  if (matrix instanceof Uint8Array) return FLAG_FL_U8
  if (matrix instanceof Uint16Array) return FLAG_FL_U16
  return 0
}

export function buildFieldLengthMatrixSection(matrix: FieldLengthArray): BinaryBytes {
  return bytesFromView(matrix)
}

export function readFieldLengthMatrixSection(
  buf: BinaryBytes,
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
