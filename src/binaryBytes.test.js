import { randomBytes } from 'node:crypto'
import {
  allocBytes,
  readFloatLE,
  writeFloatLE,
} from './binaryBytes'
import { readFloat32Array } from './binaryWireIo'

describe('binaryBytes float32 LE wire', () => {
  const ieee754Samples = [
    ['zero', 0],
    ['one point five', 1.5],
    ['negative two point two five', -2.25],
    ['subnormal', 0.0001],
    ['positive infinity', Infinity],
    ['negative infinity', -Infinity],
    ['NaN', NaN],
  ]

  test.each(ieee754Samples)('writeFloatLE + readFloatLE round-trip (%s)', (_label, value) => {
    const buf = allocBytes(4)
    writeFloatLE(buf, 0, value)
    const read = readFloatLE(buf, 0)
    if (Number.isNaN(value)) {
      expect(Number.isNaN(read)).toBe(true)
    } else {
      expect(read).toBe(Math.fround(value))
    }
  })

  test('writeFloatLE matches DataView little-endian encoding', () => {
    const buf = allocBytes(4)
    const ref = new DataView(new ArrayBuffer(4))
    ref.setFloat32(0, -2.25, true)
    writeFloatLE(buf, 0, -2.25)
    expect(Array.from(buf)).toEqual(Array.from(new Uint8Array(ref.buffer)))
  })

  test('readFloatLE at unaligned offset via readFloat32Array fallback', () => {
    const buf = allocBytes(9)
    buf[0] = 0xff
    writeFloatLE(buf, 1, 1.25)
    writeFloatLE(buf, 5, -3.5)
    const floats = readFloat32Array(buf, 1, 8)
    expect(floats[0]).toBe(1.25)
    expect(floats[1]).toBe(-3.5)
    floats[0] = 0
    expect(readFloatLE(buf, 1)).toBe(1.25)
  })

  test('readFloatLE reads bytes independent of buffer aliasing', () => {
    const source = randomBytes(8)
    const buf = allocBytes(8)
    buf.set(source)
    const at1 = readFloatLE(buf, 1)
    buf[1] = source[1] ^ 0xff
    expect(readFloatLE(buf, 1)).not.toBe(at1)
  })
})
