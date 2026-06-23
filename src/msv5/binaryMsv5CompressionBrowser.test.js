import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../FrozenMiniSearch'
import {
  CODEC_RAW,
  CODEC_ZLIB,
  CODEC_ZSTD,
  MSV5_PAYLOAD_CODEC_OFFSET,
  MSV5_SECTION_COUNT,
} from './binaryMsv5Constants'
import {
  assembleMsv5FileBrowser,
  isMsv5Bytes,
  loadMsv5SectionsBrowser,
  readMsv5GlobalFlagsBrowser,
  readMsv5SectionDirectory,
  readMsv5SnapshotCompressionMetaBrowser,
} from './binaryMsv5CompressionBrowser'
import { loadMsv5Sections } from './binaryMsv5Compression'

const options = { fields: ['title', 'text'] }
const docs = [
  { id: 1, title: 'hello', text: 'world wide' },
  { id: 2, title: 'zen', text: 'art archery' },
]

function smallIndexRawSections() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const buf = FrozenMiniSearch._fromMiniSearch(mutable, options).saveBinarySync({ compression: 'raw' })
  const directory = readMsv5SectionDirectory(buf)
  return {
    globalFlags: readMsv5GlobalFlagsBrowser(buf),
    rawSections: loadMsv5Sections(buf, directory),
  }
}

function bigCompressibleRawSections() {
  const mutable = new MiniSearch({ fields: ['text'] })
  mutable.addAll(Array.from({ length: 200 }, (_, i) => ({
    id: i,
    text: `payload ${'z'.repeat(120)} ${i}`,
  })))
  const buf = FrozenMiniSearch._fromMiniSearch(mutable, {}).saveBinarySync({ compression: 'raw' })
  const directory = readMsv5SectionDirectory(buf)
  return {
    globalFlags: readMsv5GlobalFlagsBrowser(buf),
    rawSections: loadMsv5Sections(buf, directory),
  }
}

describe('binaryMsv5CompressionBrowser', () => {
  test('isMsv5Bytes recognizes MSv5 headers', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    expect(isMsv5Bytes(assembled.buffer)).toBe(true)
    expect(isMsv5Bytes(new Uint8Array([0, 1, 2, 3]))).toBe(false)
  })

  test.each(['raw', 'zlib', 'auto'])('assemble + load round-trip (%s)', async (compression) => {
    const { globalFlags, rawSections } = bigCompressibleRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, compression)
    const meta = readMsv5SnapshotCompressionMetaBrowser(assembled.buffer)
    expect(meta.formatRev).toBeGreaterThan(0)
    if (compression === 'raw') {
      expect(meta.payloadCodec).toBe(CODEC_RAW)
    } else {
      expect(meta.payloadCodec).toBe(CODEC_ZLIB)
    }
    const directory = readMsv5SectionDirectory(assembled.buffer)
    const loaded = await loadMsv5SectionsBrowser(assembled.buffer, directory)
    expect(loaded).toHaveLength(MSV5_SECTION_COUNT)
    for (let i = 0; i < rawSections.length; i++) {
      expect(Buffer.from(loaded[i])).toEqual(Buffer.from(rawSections[i]))
    }
  })

  test('auto compresses large payloads', async () => {
    const { globalFlags, rawSections } = bigCompressibleRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'auto')
    expect(readMsv5SnapshotCompressionMetaBrowser(assembled.buffer).payloadCodec).toBe(CODEC_ZLIB)
  })

  test('assemble rejects zstd compression', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    await expect(assembleMsv5FileBrowser(globalFlags, rawSections, 'zstd'))
      .rejects.toThrow(/not supported in the browser/)
  })

  test('load rejects zstd-compressed snapshots', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    const assembled = await assembleMsv5FileBrowser(globalFlags, rawSections, 'raw')
    const zstdBuf = new Uint8Array(assembled.buffer)
    zstdBuf[MSV5_PAYLOAD_CODEC_OFFSET] = CODEC_ZSTD
    const directory = readMsv5SectionDirectory(zstdBuf)
    await expect(loadMsv5SectionsBrowser(zstdBuf, directory))
      .rejects.toThrow(/zstd-compressed/)
  })

  test('assemble rejects wrong section count', async () => {
    const { globalFlags, rawSections } = smallIndexRawSections()
    await expect(assembleMsv5FileBrowser(globalFlags, rawSections.slice(0, 1), 'raw'))
      .rejects.toThrow(new RegExp(`expects ${MSV5_SECTION_COUNT} sections`))
  })
})
