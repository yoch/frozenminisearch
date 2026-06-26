import {
  allocateFieldLengthMatrix,
  materializeFieldLengthMatrix,
  maxInArrayLike,
} from './fieldLengthMatrix'

describe('fieldLengthMatrix', () => {
  test('allocateFieldLengthMatrix chooses Uint8 when max <= 255', () => {
    const matrix = allocateFieldLengthMatrix(10, 255)
    expect(matrix).toBeInstanceOf(Uint8Array)
    expect(matrix.byteLength).toBe(10)
  })

  test('allocateFieldLengthMatrix chooses Uint16 when max is 256..65535', () => {
    const matrix = allocateFieldLengthMatrix(4, 256)
    expect(matrix).toBeInstanceOf(Uint16Array)
    expect(matrix.byteLength).toBe(8)
    const matrixMax = allocateFieldLengthMatrix(2, 65535)
    expect(matrixMax).toBeInstanceOf(Uint16Array)
  })

  test('allocateFieldLengthMatrix chooses Uint32 when max > 65535', () => {
    const matrix = allocateFieldLengthMatrix(2, 65536)
    expect(matrix).toBeInstanceOf(Uint32Array)
    expect(matrix.byteLength).toBe(8)
  })

  test('materializeFieldLengthMatrix picks width from data', () => {
    const data = [1, 50, 255, 0]
    expect(materializeFieldLengthMatrix(data)).toBeInstanceOf(Uint8Array)
    expect(materializeFieldLengthMatrix([300])).toBeInstanceOf(Uint16Array)
    expect(materializeFieldLengthMatrix([70000])).toBeInstanceOf(Uint32Array)
  })

  test('maxInArrayLike finds peak value in slice', () => {
    expect(maxInArrayLike([1, 50, 255, 0])).toBe(255)
    expect(maxInArrayLike([1, 2, 300], 2)).toBe(2)
  })
})
