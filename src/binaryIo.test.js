import { assertBufferLength, crc32Buffer } from './binaryIo'

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

describe('crc32Wire slicing-by-8', () => {
  test('matches the crc-32 library for every length, offset and seed', async () => {
    const CRC32 = (await import('crc-32')).default
    const { crc32Update: wire } = await import('./crc32Wire')
    let state = 0x9e3779b9
    const data = Buffer.alloc(300)
    for (let i = 0; i < data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      data[i] = state >>> 24
    }
    for (let start = 0; start < 9; start++) {
      for (let end = start; end <= data.length; end += end < 40 ? 1 : 37) {
        for (const seed of [0, 0xffffffff, 0x1234abcd]) {
          expect(wire(seed, data, start, end)).toBe(
            CRC32.buf(data.subarray(start, end), seed) >>> 0,
          )
        }
      }
    }
  })
})
