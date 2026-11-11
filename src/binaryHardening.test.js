import zlib from 'node:zlib'
import FrozenMiniSearch from './FrozenMiniSearch'
import FrozenMiniSearchBrowser from './FrozenMiniSearchBrowser'
import { assertLittleEndianHost } from './binaryBytes'
import { crc32Buffer } from './binaryFormat'
import {
  MSV5_HEADER_SIZE,
  MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET,
  MSV5_PAYLOAD_CRC_OFFSET,
  MSV5_SECTION_COUNT,
  MSV5_SECTION_DIR_OFFSET,
  MSV5_SECTION_ENTRY_BYTES,
  Msv5SectionId,
} from './msv5/binaryMsv5Constants'

const docs = [
  { id: 0, text: 'alpha beta', title: 'first', category: 'a' },
  { id: 1, text: 'beta gamma', title: 'second', category: 'b' },
  { id: 2, text: 'gamma delta', title: 'third', category: 'c' },
]
const options = { fields: ['text'], storeFields: ['title', 'category'] }

function rawSnapshot(storeFields = options.storeFields) {
  return Buffer.from(
    FrozenMiniSearch.fromDocuments(docs, {
      fields: ['text'],
      storeFields,
    }).saveBinarySync({ compression: 'raw' }),
  )
}

function sectionRange(buf, sectionId) {
  const dir = MSV5_SECTION_DIR_OFFSET + sectionId * MSV5_SECTION_ENTRY_BYTES
  const start = MSV5_HEADER_SIZE + buf.readUInt32LE(dir)
  return { dir, start, end: start + buf.readUInt32LE(dir + 4) }
}

/** Recompute every CRC, as an attacker forging a snapshot would. */
function reseal(buf) {
  for (let id = 0; id < MSV5_SECTION_COUNT; id++) {
    const { dir, start, end } = sectionRange(buf, id)
    buf.writeUInt32LE(crc32Buffer(buf, start, end), dir + 8)
  }
  buf.writeUInt32LE(
    crc32Buffer(buf, MSV5_HEADER_SIZE, buf.length),
    MSV5_PAYLOAD_CRC_OFFSET,
  )
  return buf
}

const loaders = [
  ['sync', async (buf, opts) => FrozenMiniSearch.loadBinarySync(buf, opts)],
  ['async', (buf, opts) => FrozenMiniSearch.loadBinaryAsync(buf, opts)],
  [
    'browser',
    (buf, opts) => FrozenMiniSearchBrowser.loadBinaryAsync(buf, opts),
  ],
]

describe('forged stored fields', () => {
  const hints = [
    ['two store fields', { storeFields: ['title', 'category'] }],
    ['one store field', { storeFields: ['title'] }],
    ['no store fields option', {}],
  ]

  test.each(hints)(
    'rejects rows sharing one heap entry (%s)',
    (_name, opts) => {
      const buf = rawSnapshot()
      const { start } = sectionRange(buf, Msv5SectionId.StoredFields)
      // Every document points at the first row.
      buf.writeUInt32LE(buf.readUInt32LE(start), start + 4)
      buf.writeUInt32LE(buf.readUInt32LE(start), start + 8)
      reseal(buf)
      expect(() => FrozenMiniSearch.loadBinarySync(buf, opts)).toThrow(
        /stored fields entry offset out of order/,
      )
    },
  )

  test('rejects heap bytes no row refers to', () => {
    const buf = rawSnapshot()
    const { start } = sectionRange(buf, Msv5SectionId.StoredFields)
    buf.writeUInt32LE(0, start + 8)
    reseal(buf)
    expect(() => FrozenMiniSearch.loadBinarySync(buf, options)).toThrow(
      /stored fields section size mismatch/,
    )
  })

  test.each([
    ['a string', (length) => `"${'a'.repeat(length - 2)}"`],
    ['an array', (length) => `[${' '.repeat(length - 2)}]`],
  ])('rejects a row that is %s', (_name, forge) => {
    const buf = rawSnapshot()
    const { start } = sectionRange(buf, Msv5SectionId.StoredFields)
    const entry = start + docs.length * 4
    const length = buf.readUInt32LE(entry)
    buf.write(forge(length), entry + 4, 'latin1')
    reseal(buf)
    expect(() => FrozenMiniSearch.loadBinarySync(buf, options)).toThrow(
      /stored fields row is not an object/,
    )
  })

  test('a __proto__ row key stays an own property of the result', async () => {
    const snapshot = JSON.parse(
      JSON.stringify(FrozenMiniSearch.fromDocuments(docs, options)),
    )
    snapshot.storedFields['0'] = JSON.parse(
      '{"title":"first","__proto__":{"polluted":true}}',
    )
    const fromJson = FrozenMiniSearch.fromJSON(
      JSON.stringify(snapshot),
      options,
    )
    const reloaded = FrozenMiniSearch.loadBinarySync(
      fromJson.saveBinarySync(),
      options,
    )
    for (const index of [fromJson, reloaded]) {
      const [result] = index.search('alpha')
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(result.polluted).toBeUndefined()
      expect(result.title).toBe('first')
      expect(Object.hasOwn(result, '__proto__')).toBe(true)
    }
  })
})

describe('forged container', () => {
  const zstd = typeof zlib.zstdCompressSync === 'function'
  let zeros
  /** A valid header in front of a stream that inflates to 64 MiB. */
  function bomb(compression, compress) {
    zeros ??= Buffer.alloc(64 * 1024 * 1024)
    const valid = Buffer.from(
      FrozenMiniSearch.fromDocuments(docs, options).saveBinarySync({
        compression,
      }),
    )
    const stream = compress(zeros)
    const forged = Buffer.concat([valid.subarray(0, MSV5_HEADER_SIZE), stream])
    forged.writeUInt32LE(stream.length, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
    return forged
  }
  const tooLong =
    /decompressed payload length mismatch|payload exceeds declared length/

  test('zlib decompression stops at the declared length', async () => {
    const forged = bomb('zlib', zlib.deflateSync)
    for (const [, load] of loaders) {
      await expect(load(forged, options)).rejects.toThrow(tooLong)
    }
  })

  test.skipIf(!zstd)(
    'zstd decompression stops at the declared length',
    async () => {
      const forged = bomb('zstd', zlib.zstdCompressSync)
      for (const [, load] of loaders.slice(0, 2)) {
        await expect(load(forged, options)).rejects.toThrow(tooLong)
      }
    },
  )

  test.each(loaders)('rejects unknown flag bits (%s)', async (_name, load) => {
    const buf = rawSnapshot()
    buf.writeUInt16LE(buf.readUInt16LE(6) | 0x8000, 6)
    await expect(load(buf, options)).rejects.toThrow(/unknown flags 0x8000/)
  })

  test.each(loaders)(
    'rejects non-zero reserved directory bytes (%s)',
    async (_name, load) => {
      const buf = rawSnapshot()
      buf.writeUInt8(1, MSV5_SECTION_DIR_OFFSET + MSV5_SECTION_ENTRY_BYTES + 12)
      await expect(load(buf, options)).rejects.toThrow(
        /section 1 reserved bytes are not zero/,
      )
    },
  )

  test.each(loaders)(
    'rejects bytes after the payload (%s)',
    async (_name, load) => {
      const buf = Buffer.concat([rawSnapshot(), Buffer.alloc(4)])
      await expect(load(buf, options)).rejects.toThrow(/payload out of bounds/)
    },
  )
})

describe('snapshot input', () => {
  test('loads from an ArrayBuffer', async () => {
    const buf = rawSnapshot()
    const arrayBuffer = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    )
    for (const [, load] of loaders) {
      const index = await load(arrayBuffer, options)
      expect(index.search('alpha').map((r) => r.id)).toEqual([0])
    }
  })

  test('loads from a view of another type', async () => {
    const buf = rawSnapshot()
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    for (const [, load] of loaders) {
      const index = await load(view, options)
      expect(index.search('alpha').map((r) => r.id)).toEqual([0])
    }
  })

  test('a store field named __proto__ is an own property of results', () => {
    for (const storeFields of [['__proto__'], ['__proto__', 'title']]) {
      const index = FrozenMiniSearch.fromDocuments(
        [{ id: 0, text: 'alpha', title: 'first', ['__proto__']: { x: 1 } }],
        { fields: ['text'], storeFields },
      )
      const [result] = index.search('alpha')
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(result.x).toBeUndefined()
    }
  })

  test.each(loaders)('rejects other input types (%s)', async (_name, load) => {
    await expect(load('MSv5', options)).rejects.toThrow(TypeError)
    await expect(load(undefined, options)).rejects.toThrow(TypeError)
  })

  test('binary snapshots refuse a big-endian host', () => {
    expect(() => assertLittleEndianHost()).not.toThrow()
    expect(() => assertLittleEndianHost(false)).toThrow(/little-endian host/)
  })
})
