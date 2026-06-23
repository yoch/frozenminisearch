import {
  assertBufferLength,
  assertSectionOffsets,
  bufferFromView,
  crc32Buffer,
  readExternalId,
  readFieldIdArray,
  readFloat32Array,
  readLengthPrefixedUtf8,
  readUint16Array,
  readUint32Array,
  readUint8Array,
  writeExternalId,
} from './binaryIo'

function encodedExternalId(id) {
  const chunks = []
  writeExternalId(chunks, id)
  return Buffer.concat(chunks)
}

describe('binaryIo', () => {
  test('validates snapshot buffer and section boundaries', () => {
    const buf = Buffer.alloc(16)

    expect(() => assertBufferLength(buf, 16)).not.toThrow()
    expect(() => assertBufferLength(buf, 17)).toThrow(/buffer too short/)

    expect(() => assertSectionOffsets(buf, 4, [4, 8, 16])).not.toThrow()
    expect(() => assertSectionOffsets(buf, 4, [3])).toThrow(/section offset 0 out of bounds/)
    expect(() => assertSectionOffsets(buf, 4, [8, 7])).toThrow(/section offsets not monotonic/)
    expect(() => assertSectionOffsets(buf, 4, [17])).toThrow(/section offset 0 out of bounds/)
  })

  test('reads typed arrays from aligned and unaligned binary sections', () => {
    const u32 = Buffer.alloc(9)
    u32.writeUInt32LE(0x01020304, 1)
    u32.writeUInt32LE(0x05060708, 5)
    expect(Array.from(readUint32Array(u32, 1, 8))).toEqual([0x01020304, 0x05060708])

    const u16 = Buffer.alloc(5)
    u16.writeUInt16LE(0x1234, 1)
    u16.writeUInt16LE(0xabcd, 3)
    expect(Array.from(readUint16Array(u16, 1, 4))).toEqual([0x1234, 0xabcd])

    const f32 = Buffer.alloc(9)
    f32.writeFloatLE(1.25, 1)
    f32.writeFloatLE(-2.5, 5)
    expect(Array.from(readFloat32Array(f32, 1, 8))).toEqual([1.25, -2.5])

    const u8 = Buffer.from([9, 8, 7, 6])
    expect(Array.from(readUint8Array(u8, 1, 2))).toEqual([8, 7])
    expect(readFieldIdArray(u8, 1, 2, 8)).toBeInstanceOf(Uint8Array)
    expect(Array.from(readFieldIdArray(u16, 1, 4, 16))).toEqual([0x1234, 0xabcd])
  })

  test('rejects malformed typed-array sections', () => {
    const buf = Buffer.alloc(8)

    expect(() => readUint32Array(buf, 0, 2)).toThrow(/uint32 section length not aligned/)
    expect(() => readUint32Array(buf, 4, 8)).toThrow(/uint32 section read past buffer end/)
    expect(() => readUint16Array(buf, 0, 3)).toThrow(/uint16 section length not aligned/)
    expect(() => readUint16Array(buf, 7, 2)).toThrow(/uint16 section read past buffer end/)
    expect(() => readUint8Array(buf, 7, 2)).toThrow(/uint8 section read past buffer end/)
    expect(() => readFloat32Array(buf, 0, 2)).toThrow(/float32 section length not aligned/)
    expect(() => readFloat32Array(buf, 4, 8)).toThrow(/float32 section read past buffer end/)
  })

  test('round-trips external ids used by binary snapshots', () => {
    const ids = [undefined, 42.5, 'doc-1', { slug: 'nested', page: 3 }]
    const buf = Buffer.concat(ids.map(encodedExternalId))
    const decoded = []
    let offset = 0

    for (const id of ids) {
      const result = readExternalId(buf, offset)
      decoded.push(result.value)
      offset = result.next
      expect(offset).toBeLessThanOrEqual(buf.length)
      expect(id === undefined || result.value !== undefined).toBe(true)
    }

    expect(decoded).toEqual(ids)
    expect(offset).toBe(buf.length)
  })

  test('rejects corrupted external-id payloads', () => {
    expect(() => readExternalId(Buffer.alloc(0), 0)).toThrow(/external id tag truncated/)
    expect(() => readExternalId(Buffer.from([255]), 0)).toThrow(/unknown external id tag 255/)
    expect(() => readExternalId(encodedExternalId(12).subarray(0, 5), 0))
      .toThrow(/external id number truncated/)
    expect(() => readExternalId(encodedExternalId('abc').subarray(0, 4), 0))
      .toThrow(/length-prefixed string header truncated/)
    expect(() => readExternalId(encodedExternalId('abc').subarray(0, 7), 0))
      .toThrow(/length-prefixed string body out of bounds/)
  })

  test('handles sliced buffers without losing byte offsets', () => {
    const view = new Uint16Array([0x1111, 0x2222, 0x3333]).subarray(1, 3)
    const buf = bufferFromView(view)

    expect(buf.byteLength).toBe(4)
    expect(buf.readUInt16LE(0)).toBe(0x2222)
    expect(buf.readUInt16LE(2)).toBe(0x3333)
  })

  test('computes CRC-32 for whole buffers and slices', () => {
    const buf = Buffer.from('xx123456789yy')

    expect(crc32Buffer(buf, 2, 11)).toBe(0xcbf43926)
    expect(crc32Buffer(buf.subarray(2, 11))).toBe(0xcbf43926)
  })

  test('reads length-prefixed strings at arbitrary offsets', () => {
    const buf = Buffer.alloc(9)
    buf.writeUInt32LE(1, 3)
    buf.write('z', 7)

    expect(readLengthPrefixedUtf8(buf, 3)).toEqual({ value: 'z', next: 8 })
  })
})
