import {
  buildFieldLengthMatrixSection,
  fieldLengthMatrixWireFlags,
  readFieldLengthMatrixSection,
} from './fieldLengthMatrixWire'
import { FLAG_FL_U8, FLAG_FL_U16 } from './msv5/binaryMsv5Constants'

describe('fieldLengthMatrixWire', () => {
  test.each([
    [new Uint8Array([1, 2, 255]), FLAG_FL_U8, Uint8Array],
    [new Uint16Array([1, 256, 65535]), FLAG_FL_U16, Uint16Array],
    [new Uint32Array([1, 65536, 70000]), 0, Uint32Array],
  ])('round-trips %s field-length matrices with width flags', (matrix, flags, MatrixCtor) => {
    const section = buildFieldLengthMatrixSection(matrix)

    expect(fieldLengthMatrixWireFlags(matrix)).toBe(flags)
    const decoded = readFieldLengthMatrixSection(section, flags, matrix.length)
    expect(decoded).toBeInstanceOf(MatrixCtor)
    expect(Array.from(decoded)).toEqual(Array.from(matrix))
  })

  test('preserves byte offsets when building a matrix section from a view', () => {
    const backing = new Uint16Array([99, 5, 6, 99])
    const matrix = backing.subarray(1, 3)
    const section = buildFieldLengthMatrixSection(matrix)

    expect(section.byteLength).toBe(4)
    expect(Array.from(readFieldLengthMatrixSection(section, FLAG_FL_U16, 2))).toEqual([5, 6])
  })

  test('rejects field-length sections whose size does not match the declared width', () => {
    expect(() => readFieldLengthMatrixSection(new Uint8Array([1]), FLAG_FL_U8, 2))
      .toThrow(/fieldLengthMatrix u8 size mismatch/)
    expect(() => readFieldLengthMatrixSection(new Uint8Array([1, 0]), FLAG_FL_U16, 2))
      .toThrow(/fieldLengthMatrix u16 size mismatch/)
    expect(() => readFieldLengthMatrixSection(new Uint8Array([1, 0, 0, 0]), 0, 2))
      .toThrow(/fieldLengthMatrix u32 size mismatch/)
  })

  test('decodes empty matrices without borrowing an unrelated backing buffer', () => {
    expect(readFieldLengthMatrixSection(new Uint8Array(0), FLAG_FL_U8, 0)).toEqual(new Uint8Array(0))
    expect(readFieldLengthMatrixSection(new Uint8Array(0), FLAG_FL_U16, 0)).toEqual(new Uint16Array(0))
    expect(readFieldLengthMatrixSection(new Uint8Array(0), 0, 0)).toEqual(new Uint32Array(0))
  })
})
