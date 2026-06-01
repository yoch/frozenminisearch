import MiniSearch from '../MiniSearch'
import FrozenMiniSearch from '../FrozenMiniSearch'
import {
  decodeFrozenSnapshot,
  BINARY_MAGIC_V5,
  readMsv5SnapshotCompressionMeta,
  MSV5_ZSTD_LEVEL,
} from '../binaryFormat'
import { encodeFrozenSnapshotMSv4 } from '../binaryEncode'
import {
  CODEC_RAW,
  CODEC_ZSTD,
  MSV5_FORMAT_REV_PAYLOAD,
  MSV5_HEADER_SIZE,
  MSV5_PAYLOAD_CRC_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_OFFSET,
  MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET,
  MSV5_SECTION_DIR_OFFSET,
  Msv5SectionId,
  zstdCompressionWorthKeeping,
} from './binaryMsv5Constants'
import { encodeFrozenSnapshotMsv5 } from './binaryMsv5Encode'
import {
  loadMsv5SectionsFromZstdStream,
  readMsv5SectionDirectory,
} from './binaryMsv5Compression'

const options = { fields: ['title', 'text'] }
const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' },
]

function msv5SectionDirOffset(sectionId) {
  return MSV5_SECTION_DIR_OFFSET + sectionId * 20
}

describe('binaryMsv5', () => {
  test('encodeFrozenSnapshot uses MSv5 by default', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = mutable.freeze().saveBinary()
    expect(buf.toString('ascii', 0, 4)).toBe(BINARY_MAGIC_V5)
    expect(buf.length).toBeGreaterThan(MSV5_HEADER_SIZE)
  })

  test('MSv5 round-trip preserves search', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    const loaded = FrozenMiniSearch.loadBinary(frozen.saveBinary(), options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('MSv5 async stream load preserves search', async () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const frozen = mutable.freeze()
    const loaded = await FrozenMiniSearch.loadBinaryAsync(frozen.saveBinary(), options)
    expect(loaded.search('zen')).toEqual(frozen.search('zen'))
  })

  test('zstdCompressionWorthKeeping: 10% relative or 10 KiB absolute', () => {
    expect(zstdCompressionWorthKeeping(90, 100)).toBe(true)
    expect(zstdCompressionWorthKeeping(91, 100)).toBe(false)
    expect(zstdCompressionWorthKeeping(99_000, 110_000)).toBe(true)
    expect(zstdCompressionWorthKeeping(100_500, 110_000)).toBe(false)
  })

  test('single payload zstd stream with per-section catalogue offsets', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const buf = mutable.freeze().saveBinary()
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.formatRev).toBe(MSV5_FORMAT_REV_PAYLOAD)
    expect(meta.sections.length).toBe(12)
  })

  test('large index uses one zstd payload when worthwhile', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(Array.from({ length: 200 }, (_, i) => ({
      id: i,
      text: `payload ${'z'.repeat(120)} ${i}`,
    })))
    const buf = mutable.freeze().saveBinary()
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.formatRev).toBe(MSV5_FORMAT_REV_PAYLOAD)
    expect(meta.payloadCodec === CODEC_ZSTD || meta.payloadCodec === CODEC_RAW).toBe(true)
    if (meta.payloadCodec === CODEC_ZSTD) {
      expect(meta.zstdLevel).toBe(MSV5_ZSTD_LEVEL)
      expect(meta.compressedLength).toBeLessThan(meta.uncompressedLength)
    }
    const payloadOff = buf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_OFFSET)
    expect(payloadOff).toBe(MSV5_HEADER_SIZE)
    expect(FrozenMiniSearch.loadBinary(buf, { fields: ['text'] }).search('payload').length)
      .toBeGreaterThan(0)
  })

  test('rejects zstd payload CRC mismatch', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(Array.from({ length: 200 }, (_, i) => ({
      id: i,
      text: `payload ${'z'.repeat(120)} ${i}`,
    })))
    const buf = Buffer.from(mutable.freeze().saveBinary())
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.payloadCodec).toBe(CODEC_ZSTD)
    const stored = buf.readUInt32LE(MSV5_PAYLOAD_CRC_OFFSET)
    buf.writeUInt32LE((stored ^ 1) >>> 0, MSV5_PAYLOAD_CRC_OFFSET)
    expect(() => FrozenMiniSearch.loadBinary(buf, { fields: ['text'] }))
      .toThrow(/payload CRC mismatch/)
  })

  test('streaming zstd reader rejects output past declared uncompressed length', async () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(Array.from({ length: 200 }, (_, i) => ({
      id: i,
      text: `payload ${'z'.repeat(120)} ${i}`,
    })))
    const buf = Buffer.from(mutable.freeze().saveBinary())
    const meta = readMsv5SnapshotCompressionMeta(buf)
    expect(meta.payloadCodec).toBe(CODEC_ZSTD)

    const freqsDir = msv5SectionDirOffset(Msv5SectionId.AllFreqs)
    const freqsLen = buf.readUInt32LE(freqsDir + 4)
    expect(freqsLen).toBeGreaterThan(0)
    buf.writeUInt32LE(freqsLen - 1, freqsDir + 4)
    buf.writeUInt32LE(meta.uncompressedLength - 1, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)

    const payloadOff = buf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_OFFSET)
    await expect(loadMsv5SectionsFromZstdStream(
      buf.subarray(payloadOff, payloadOff + meta.compressedLength),
      readMsv5SectionDirectory(buf),
      meta.uncompressedLength - 1,
      meta.payloadCrc32,
    )).rejects.toThrow(/exceeds declared length/)
  })

  test('rejects payload sizes above 1 GiB', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(docs)
    const buf = Buffer.from(mutable.freeze().saveBinary())
    buf.writeUInt32LE(1024 * 1024 * 1024 + 1, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
    expect(() => FrozenMiniSearch.loadBinary(buf, { fields: ['text'] }))
      .toThrow(/1 GiB/)
  })

  test('encodeFrozenSnapshotMsv5 round-trips programmatic snapshot', () => {
    const mutable = new MiniSearch({ fields: ['text'] })
    mutable.addAll(Array.from({ length: 50 }, (_, i) => ({ id: i, text: `doc ${i}` })))
    const snap = decodeFrozenSnapshot(mutable.freeze().saveBinary())
    const buf = encodeFrozenSnapshotMsv5(snap)
    const dir = readMsv5SectionDirectory(buf)
    expect(dir[Msv5SectionId.Core].uncompressedLength).toBe(16)
    expect(FrozenMiniSearch.loadBinary(buf, { fields: ['text'] }).search('doc').length)
      .toBeGreaterThan(0)
  })

  test('loadBinary still reads legacy MSv4', () => {
    const mutable = new MiniSearch(options)
    mutable.addAll(docs)
    const snap = decodeFrozenSnapshot(mutable.freeze().saveBinary())
    const legacy = encodeFrozenSnapshotMSv4(snap)
    const loaded = FrozenMiniSearch.loadBinary(legacy, options)
    expect(loaded.search('hello').length).toBeGreaterThan(0)
  })
})

describe('binaryMsv5 load memory', () => {
  test('heap after loadBinaryAsync stays bounded vs file size', async () => {
    if (typeof global.gc !== 'function') {
      return
    }
    const mutable = new MiniSearch({ fields: ['text'] })
    const big = Array.from({ length: 8000 }, (_, i) => ({
      id: i,
      text: `term${i % 200} repeated content ${i}`,
    }))
    mutable.addAll(big)
    const buf = mutable.freeze().saveBinary()
    const fileBytes = buf.length

    global.gc()
    const heapBefore = process.memoryUsage().heapUsed
    await FrozenMiniSearch.loadBinaryAsync(buf, { fields: ['text'] })
    global.gc()
    const heapAfter = process.memoryUsage().heapUsed
    const delta = heapAfter - heapBefore

    expect(delta).toBeLessThan(fileBytes * 1.35 + 8 * 1024 * 1024)
  })
})
