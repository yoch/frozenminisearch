import {
  assertBufferLength,
  crc32Buffer,
} from './binaryIo'

describe('binaryIo', () => {
  test('validates snapshot buffer length', () => {
    const buf = Buffer.alloc(16)

    expect(() => assertBufferLength(buf, 16)).not.toThrow()
    expect(() => assertBufferLength(buf, 17)).toThrow(/buffer too short/)
  })

  test('computes CRC-32 for whole buffers and slices', () => {
    const buf = Buffer.from('xx123456789yy')

    expect(crc32Buffer(buf, 2, 11)).toBe(0xcbf43926)
    expect(crc32Buffer(buf.subarray(2, 11))).toBe(0xcbf43926)
  })
})
