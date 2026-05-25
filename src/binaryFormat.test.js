import { encodeFrozenSnapshot, decodeFrozenSnapshot, BINARY_MAGIC_V2 } from './binaryFormat'

describe('binaryFormat MSv2', () => {
  test('round-trip preserves flat postings', () => {
    const snap = {
      documentCount: 2,
      nextId: 2,
      fieldIds: { txt: 0 },
      fieldCount: 1,
      avgFieldLength: new Float32Array([2, 2]),
      externalIds: [1, 2],
      storedFields: [undefined, undefined],
      fieldLengthMatrix: new Uint32Array([1, 0, 2, 0]),
      terms: ['hello', 'world'],
      treeShape: [['hello', 0], ['world', 1]],
      postingsOffsets: new Uint32Array([0, 1]),
      postingsLengths: new Uint32Array([1, 1]),
      allDocIds: new Uint32Array([0, 1]),
      allFreqs: new Uint8Array([1, 1])
    }

    const buf = encodeFrozenSnapshot(snap)
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V2)

    const loaded = decodeFrozenSnapshot(buf)
    expect(loaded.documentCount).toBe(2)
    expect(loaded.terms).toEqual(['hello', 'world'])
    expect(Array.from(loaded.allDocIds)).toEqual([0, 1])
    expect(Array.from(loaded.allFreqs)).toEqual([1, 1])
    expect(Array.from(loaded.postingsLengths)).toEqual([1, 1])
  })
})

describe('binaryFormat MSv1 read', () => {
  test('rejects unknown binary magic', () => {
    const buf = Buffer.alloc(32)
    buf.write('XXXX', 0, 4, 'ascii')
    expect(() => decodeFrozenSnapshot(buf)).toThrow(/Invalid frozen index/)
  })
})
