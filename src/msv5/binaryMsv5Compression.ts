import zlib from 'node:zlib'
import type { Transform } from 'node:stream'
import { crc32Buffer, crc32Update } from '../binaryIo'
import type { BinaryCompression } from '../searchTypes'
import {
  CODEC_RAW,
  CODEC_ZLIB,
  CODEC_ZSTD,
  MSV5_FORMAT_REV_OFFSET,
  MSV5_FORMAT_REV_PAYLOAD,
  MSV5_HEADER_SIZE,
  MSV5_MIN_COMPRESS_BYTES,
  MSV5_PAYLOAD_CODEC_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET,
  MSV5_PAYLOAD_COMPRESSED_OFFSET,
  MSV5_PAYLOAD_CRC_OFFSET,
  MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET,
  MSV5_SECTION_COUNT,
  MSV5_SECTION_COUNT_OFFSET,
  MSV5_SECTION_DIR_OFFSET,
  MSV5_SECTION_ENTRY_BYTES,
  MSV5_ZSTD_LEVEL,
  MSV5_ZSTD_LEVEL_OFFSET,
} from './binaryMsv5Constants'

export interface Msv5SectionEntry {
  /** Offset of this section inside the uncompressed payload (4-byte aligned). */
  fileOffset: number
  uncompressedLength: number
  sectionCrc32: number
}

export interface Msv5SectionCompressionRecord {
  sectionId: number
  uncompressedOffset: number
  uncompressedLength: number
  sectionCrc32: number
}

export interface Msv5SnapshotCompressionMeta {
  formatRev: number
  payloadCodec: number
  zstdLevel: number
  uncompressedLength: number
  compressedLength: number
  payloadCrc32: number
  sections: Msv5SectionCompressionRecord[]
}

export interface Msv5AssembledFile {
  buffer: Buffer
  globalFlags: number
  compression: Msv5SnapshotCompressionMeta
}

/** Hard cap on the uncompressed payload, rejected before allocation (compressed-bomb guard).
 *  This is the single trust boundary for untrusted snapshots: {@link readPayloadMeta} rejects
 *  headers above this size; sync decompress uses the same cap via `maxOutputLength`.
 *  A malicious header can still declare up to 1 GiB — no tighter native limit helps without
 *  trusting `uncompressedLength` from that same header. Semantic integrity (length match,
 *  payload CRC, per-section CRC) is enforced after decode. */
const MSV5_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MSV5_COMPRESSED_PAYLOAD_EXCEEDS_LENGTH = 'MSv5 compressed payload exceeds declared length'
const MSV5_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH = 'MSv5 decompressed payload length mismatch'

// zstd landed in node:zlib at Node 22.15.0 (22.x line) / 23.8.0, where the whole family
// (zstdCompress[Sync], zstdDecompressSync, createZstdDecompress) ships together — so probing one
// member is enough to know if the runtime supports zstd. Checked at call time (not captured at
// module load) so it stays mockable in tests. On older runtimes we degrade gracefully: `auto`
// tries zlib once (or raw if it does not help). When zstd is available, `auto` tries zstd once
// and stays raw if it does not shrink — no second pass. Reads of a zstd payload throw a clear,
// actionable error on runtimes without zstd.
function zstdAvailable(): boolean {
  return typeof zlib.zstdCompressSync === 'function'
}

function zstdUnavailableWriteError(): Error {
  return new Error(
    'MSv5 snapshot requested zstd compression, but this Node.js runtime lacks node:zlib zstd '
    + 'support (added in Node 22.15.0). Upgrade Node.js, or use compression: "auto", "raw", '
    + 'or "zlib".',
  )
}

function zstdUnavailableReadError(): Error {
  return new Error(
    'MSv5 snapshot is zstd-compressed, but this Node.js runtime lacks node:zlib zstd support '
    + '(added in Node 22.15.0). Upgrade Node.js to read this snapshot, or re-save it from a '
    + 'newer runtime with compression: "raw" or "zlib".',
  )
}

let warnedZstdSaveFallback = false
function warnZstdSaveFallbackOnce(): void {
  if (warnedZstdSaveFallback) return
  warnedZstdSaveFallback = true
  process.emitWarning(
    'node:zlib zstd APIs are unavailable (Node.js < 22.15.0); compression: "auto" falls back to '
    + 'zlib when it shrinks the payload, otherwise raw (uncompressed). Upgrade to Node 22.15.0+ '
    + 'for zstd.',
    { code: 'MINISEARCH_MSV5_ZSTD_UNAVAILABLE' },
  )
}

/** Test-only: clears the once-per-process zstd-unavailable save warning latch. */
export function resetMsv5ZstdWarningForTests(): void {
  warnedZstdSaveFallback = false
}

function assertPayloadFormatRev(buf: Buffer): void {
  const rev = buf.readUInt16LE(MSV5_FORMAT_REV_OFFSET)
  if (rev !== MSV5_FORMAT_REV_PAYLOAD) {
    throw new Error(`MSv5 unsupported format revision ${rev}`)
  }
}

function readPayloadMeta(fileBuf: Buffer): {
  payloadOffset: number
  compressedLength: number
  uncompressedLength: number
  payloadCrc32: number
  payloadCodec: number
} {
  const payloadOffset = fileBuf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_OFFSET)
  const compressedLength = fileBuf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
  const uncompressedLength = fileBuf.readUInt32LE(MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
  const payloadCrc32 = fileBuf.readUInt32LE(MSV5_PAYLOAD_CRC_OFFSET)
  const payloadCodec = fileBuf.readUInt8(MSV5_PAYLOAD_CODEC_OFFSET)
  if (uncompressedLength > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error('MSv5 payload exceeds 1 GiB limit')
  }
  return { payloadOffset, compressedLength, uncompressedLength, payloadCrc32, payloadCodec }
}

function concatRawSections(rawSections: Buffer[]): {
  uncompressed: Buffer
  entries: Msv5SectionEntry[]
} {
  const entries: Msv5SectionEntry[] = []
  let uncompressedLength = 0

  for (const raw of rawSections) {
    uncompressedLength = (uncompressedLength + 3) & ~3
    entries.push({
      fileOffset: uncompressedLength,
      uncompressedLength: raw.length,
      sectionCrc32: crc32Buffer(raw),
    })
    uncompressedLength += raw.length
  }

  const uncompressed = Buffer.alloc(uncompressedLength)
  for (let i = 0; i < rawSections.length; i++) {
    rawSections[i].copy(uncompressed, entries[i].fileOffset)
  }

  return { uncompressed, entries }
}

/** Shared zstd encoder options for sync and async save paths.
 *  - `pledgedSrcSize`: exact input size is known; lets libzstd size its window and buffers.
 *  - `ZSTD_c_checksumFlag: 0`: MSv5 already stores payload + per-section CRC-32; frame checksum is redundant CPU.
 *  Cast: `pledgedSrcSize` is supported at runtime by Node zlib but may lag in typings. */
function msv5ZstdCompressOptions(
  uncompressed: Buffer,
): NonNullable<Parameters<typeof zlib.zstdCompressSync>[1]> {
  return {
    pledgedSrcSize: uncompressed.length,
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: MSV5_ZSTD_LEVEL,
      [zlib.constants.ZSTD_c_checksumFlag]: 0,
    },
  } as NonNullable<Parameters<typeof zlib.zstdCompressSync>[1]>
}

interface PayloadCodecChoice {
  payload: Buffer
  codec: number
  zstdLevel: number
}

function rawPayloadChoice(uncompressed: Buffer): PayloadCodecChoice {
  return { payload: uncompressed, codec: CODEC_RAW, zstdLevel: 0 }
}

/** Auto mode: one compression attempt; keep it only when strictly smaller than raw. */
function pickAutoPayloadCodec(uncompressed: Buffer, compressed: Buffer, codec: number): PayloadCodecChoice {
  if (compressed.length < uncompressed.length) {
    return {
      payload: compressed,
      codec,
      zstdLevel: codec === CODEC_ZSTD ? MSV5_ZSTD_LEVEL : 0,
    }
  }
  return rawPayloadChoice(uncompressed)
}

function zstdPayloadChoiceSync(uncompressed: Buffer): PayloadCodecChoice {
  if (!zstdAvailable()) {
    throw zstdUnavailableWriteError()
  }
  const compressed = zlib.zstdCompressSync(uncompressed, msv5ZstdCompressOptions(uncompressed))
  return { payload: compressed, codec: CODEC_ZSTD, zstdLevel: MSV5_ZSTD_LEVEL }
}

/**
 * Async zstd via {@link zstdCompress} (not {@link zstdCompressSync}).
 * Same level and input yield the same *decompressed* payload (catalogue CRC matches sync),
 * but the compressed blob is not guaranteed bit-identical — libzstd may pick a different
 * frame layout; only `payload.length` in the header differs.
 */
function zstdCompressAsync(uncompressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(
      uncompressed,
      msv5ZstdCompressOptions(uncompressed),
      (err, compressed) => {
        if (err != null) {
          reject(err)
          return
        }
        resolve(compressed)
      },
    )
  })
}

async function zstdPayloadChoiceAsync(uncompressed: Buffer): Promise<PayloadCodecChoice> {
  if (!zstdAvailable()) {
    throw zstdUnavailableWriteError()
  }
  const compressed = await zstdCompressAsync(uncompressed)
  return { payload: compressed, codec: CODEC_ZSTD, zstdLevel: MSV5_ZSTD_LEVEL }
}

function zlibPayloadChoiceSync(uncompressed: Buffer): PayloadCodecChoice {
  const compressed = zlib.deflateSync(uncompressed)
  return { payload: compressed, codec: CODEC_ZLIB, zstdLevel: 0 }
}

function zlibCompressAsync(uncompressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.deflate(uncompressed, (err, compressed) => {
      if (err != null) {
        reject(err)
        return
      }
      resolve(compressed)
    })
  })
}

async function zlibPayloadChoiceAsync(uncompressed: Buffer): Promise<PayloadCodecChoice> {
  const compressed = await zlibCompressAsync(uncompressed)
  return { payload: compressed, codec: CODEC_ZLIB, zstdLevel: 0 }
}

interface AutoPayloadCompressors {
  zstd: (uncompressed: Buffer) => Buffer
  zlib: (uncompressed: Buffer) => Buffer
}

interface AutoPayloadCompressorsAsync {
  zstd: (uncompressed: Buffer) => Promise<Buffer>
  zlib: (uncompressed: Buffer) => Promise<Buffer>
}

const autoSyncCompressors: AutoPayloadCompressors = {
  zstd: (uncompressed) => zlib.zstdCompressSync(uncompressed, msv5ZstdCompressOptions(uncompressed)),
  zlib: (uncompressed) => zlib.deflateSync(uncompressed),
}

const autoAsyncCompressors: AutoPayloadCompressorsAsync = {
  zstd: zstdCompressAsync,
  zlib: zlibCompressAsync,
}

function autoPayloadChoice(
  uncompressed: Buffer,
  compressors: AutoPayloadCompressors,
): PayloadCodecChoice {
  if (uncompressed.length < MSV5_MIN_COMPRESS_BYTES) {
    return rawPayloadChoice(uncompressed)
  }
  if (!zstdAvailable()) {
    warnZstdSaveFallbackOnce()
    return pickAutoPayloadCodec(uncompressed, compressors.zlib(uncompressed), CODEC_ZLIB)
  }
  return pickAutoPayloadCodec(uncompressed, compressors.zstd(uncompressed), CODEC_ZSTD)
}

async function autoPayloadChoiceAsync(
  uncompressed: Buffer,
  compressors: AutoPayloadCompressorsAsync,
): Promise<PayloadCodecChoice> {
  if (uncompressed.length < MSV5_MIN_COMPRESS_BYTES) {
    return rawPayloadChoice(uncompressed)
  }
  if (!zstdAvailable()) {
    warnZstdSaveFallbackOnce()
    return pickAutoPayloadCodec(uncompressed, await compressors.zlib(uncompressed), CODEC_ZLIB)
  }
  return pickAutoPayloadCodec(uncompressed, await compressors.zstd(uncompressed), CODEC_ZSTD)
}

function choosePayloadCodecSync(
  uncompressed: Buffer,
  compression: BinaryCompression = 'auto',
): PayloadCodecChoice {
  switch (compression) {
    case 'raw':
      return rawPayloadChoice(uncompressed)
    case 'zstd':
      return zstdPayloadChoiceSync(uncompressed)
    case 'zlib':
      return zlibPayloadChoiceSync(uncompressed)
    case 'auto':
      return autoPayloadChoice(uncompressed, autoSyncCompressors)
    default: {
      const _exhaustive: never = compression
      return _exhaustive
    }
  }
}

async function choosePayloadCodecAsync(
  uncompressed: Buffer,
  compression: BinaryCompression = 'auto',
): Promise<PayloadCodecChoice> {
  switch (compression) {
    case 'raw':
      return rawPayloadChoice(uncompressed)
    case 'zstd':
      return await zstdPayloadChoiceAsync(uncompressed)
    case 'zlib':
      return await zlibPayloadChoiceAsync(uncompressed)
    case 'auto':
      return await autoPayloadChoiceAsync(uncompressed, autoAsyncCompressors)
    default: {
      const _exhaustive: never = compression
      return _exhaustive
    }
  }
}

function concatAndValidateSections(rawSections: Buffer[]): {
  uncompressed: Buffer
  entries: Msv5SectionEntry[]
  payloadCrc32: number
} {
  if (rawSections.length !== MSV5_SECTION_COUNT) {
    throw new Error(`MSv5 expects ${MSV5_SECTION_COUNT} sections, got ${rawSections.length}`)
  }
  const { uncompressed, entries } = concatRawSections(rawSections)
  if (uncompressed.length > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error('MSv5 payload exceeds 1 GiB limit')
  }
  return { uncompressed, entries, payloadCrc32: crc32Buffer(uncompressed) }
}

/** Writes MSv5 header + section catalogue and appends the payload blob. */
function buildMsv5AssembledFile(
  globalFlags: number,
  entries: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
  payload: Buffer,
  codec: number,
  zstdLevel: number,
): Msv5AssembledFile {
  const out = Buffer.alloc(MSV5_HEADER_SIZE + payload.length)
  out.write('MSv5', 0, 4, 'ascii')
  out.writeUInt16LE(5, 4)
  out.writeUInt16LE(globalFlags & 0xffff, 6)
  out.writeUInt8(codec, MSV5_PAYLOAD_CODEC_OFFSET)
  out.writeUInt8(zstdLevel, MSV5_ZSTD_LEVEL_OFFSET)
  out.writeUInt16LE(MSV5_FORMAT_REV_PAYLOAD, MSV5_FORMAT_REV_OFFSET)
  out.writeUInt32LE(MSV5_SECTION_COUNT, MSV5_SECTION_COUNT_OFFSET)

  out.writeUInt32LE(MSV5_HEADER_SIZE, MSV5_PAYLOAD_COMPRESSED_OFFSET)
  out.writeUInt32LE(payload.length, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
  out.writeUInt32LE(uncompressedLength, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
  out.writeUInt32LE(payloadCrc32, MSV5_PAYLOAD_CRC_OFFSET)

  let dirOff = MSV5_SECTION_DIR_OFFSET
  for (const e of entries) {
    out.writeUInt32LE(e.fileOffset, dirOff)
    out.writeUInt32LE(e.uncompressedLength, dirOff + 4)
    out.writeUInt32LE(e.sectionCrc32, dirOff + 8)
    dirOff += MSV5_SECTION_ENTRY_BYTES
  }

  payload.copy(out, MSV5_HEADER_SIZE)

  return {
    buffer: out,
    globalFlags,
    compression: {
      formatRev: MSV5_FORMAT_REV_PAYLOAD,
      payloadCodec: codec,
      zstdLevel,
      uncompressedLength,
      compressedLength: payload.length,
      payloadCrc32,
      sections: entries.map((e, sectionId) => ({
        sectionId,
        uncompressedOffset: e.fileOffset,
        uncompressedLength: e.uncompressedLength,
        sectionCrc32: e.sectionCrc32,
      })),
    },
  }
}

/**
 * MSv5 on disk: header + catalogue (uncompressed offsets) + **one** payload blob
 * (raw concatenation or a single compressed stream over it).
 */
export function assembleMsv5File(
  globalFlags: number,
  rawSections: Buffer[],
  compression: BinaryCompression = 'auto',
): Msv5AssembledFile {
  const { uncompressed, entries, payloadCrc32 } = concatAndValidateSections(rawSections)
  const { payload, codec, zstdLevel } = choosePayloadCodecSync(uncompressed, compression)
  return buildMsv5AssembledFile(
    globalFlags,
    entries,
    uncompressed.length,
    payloadCrc32,
    payload,
    codec,
    zstdLevel,
  )
}

export async function assembleMsv5FileAsync(
  globalFlags: number,
  rawSections: Buffer[],
  compression: BinaryCompression = 'auto',
): Promise<Msv5AssembledFile> {
  const { uncompressed, entries, payloadCrc32 } = concatAndValidateSections(rawSections)
  const { payload, codec, zstdLevel } = await choosePayloadCodecAsync(uncompressed, compression)
  return buildMsv5AssembledFile(
    globalFlags,
    entries,
    uncompressed.length,
    payloadCrc32,
    payload,
    codec,
    zstdLevel,
  )
}

export function readMsv5SectionDirectory(buf: Buffer): Msv5SectionEntry[] {
  if (buf.length < MSV5_HEADER_SIZE) {
    throw new Error('MSv5 buffer too short for header')
  }
  const sectionCount = buf.readUInt32LE(MSV5_SECTION_COUNT_OFFSET)
  if (sectionCount !== MSV5_SECTION_COUNT) {
    throw new Error(`MSv5 section count mismatch: ${sectionCount}`)
  }
  assertPayloadFormatRev(buf)
  const entries: Msv5SectionEntry[] = []
  let dirOff = MSV5_SECTION_DIR_OFFSET
  for (let i = 0; i < sectionCount; i++) {
    entries.push({
      fileOffset: buf.readUInt32LE(dirOff),
      uncompressedLength: buf.readUInt32LE(dirOff + 4),
      sectionCrc32: buf.readUInt32LE(dirOff + 8),
    })
    dirOff += MSV5_SECTION_ENTRY_BYTES
  }
  return entries
}

export function readMsv5SnapshotCompressionMeta(buf: Buffer): Msv5SnapshotCompressionMeta {
  const directory = readMsv5SectionDirectory(buf)
  return {
    formatRev: MSV5_FORMAT_REV_PAYLOAD,
    payloadCodec: buf.readUInt8(MSV5_PAYLOAD_CODEC_OFFSET),
    zstdLevel: buf.readUInt8(MSV5_ZSTD_LEVEL_OFFSET),
    uncompressedLength: buf.readUInt32LE(MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET),
    compressedLength: buf.readUInt32LE(MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET),
    payloadCrc32: buf.readUInt32LE(MSV5_PAYLOAD_CRC_OFFSET),
    sections: directory.map((e, sectionId) => ({
      sectionId,
      uncompressedOffset: e.fileOffset,
      uncompressedLength: e.uncompressedLength,
      sectionCrc32: e.sectionCrc32,
    })),
  }
}

function verifySectionCrc(section: Buffer, expected: number): void {
  if (crc32Buffer(section) !== expected) {
    throw new Error('MSv5 section CRC mismatch')
  }
}

/** Slice each section out of a fully materialized payload (zero-copy when 4-byte aligned). */
function sectionsFromPayload(
  payload: Buffer,
  directory: Msv5SectionEntry[],
  payloadCrc32: number,
): Buffer[] {
  if (crc32Buffer(payload) !== payloadCrc32) {
    throw new Error('MSv5 payload CRC mismatch')
  }
  return directory.map((entry) => {
    const slice = payload.subarray(entry.fileOffset, entry.fileOffset + entry.uncompressedLength)
    verifySectionCrc(slice, entry.sectionCrc32)
    if ((payload.byteOffset + entry.fileOffset) % 4 === 0) return slice
    const out = Buffer.alloc(entry.uncompressedLength)
    slice.copy(out, 0)
    return out
  })
}

/** Streaming compressed reader: keeps only one section in memory at a time.
 *  No `maxOutputLength` on Transform streams: output is bounded by accumulating `streamOffset`
 *  against the header's `uncompressedLength` (same 1 GiB cap checked upfront). Sync load uses
 *  `maxOutputLength` because it materializes the whole payload at once. */
function collectCompressedPayloadSections(
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
): {
  sections: Buffer[]
  consume: (chunk: Buffer) => void
  finish: () => void
} {
  if (uncompressedLength > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error('MSv5 payload exceeds 1 GiB limit')
  }
  const sections: Buffer[] = new Array(directory.length)
  let sectionId = 0
  let streamOffset = 0
  let current: Buffer | null = null
  let payloadCrc = 0

  function emitEmptySections(): void {
    while (
      sectionId < directory.length
      && directory[sectionId].uncompressedLength === 0
      && directory[sectionId].fileOffset === streamOffset
    ) {
      verifySectionCrc(Buffer.alloc(0), directory[sectionId].sectionCrc32)
      sections[sectionId] = Buffer.alloc(0)
      sectionId++
    }
  }

  function consume(chunk: Buffer): void {
    if (streamOffset + chunk.length > uncompressedLength) {
      throw new Error(MSV5_COMPRESSED_PAYLOAD_EXCEEDS_LENGTH)
    }

    payloadCrc = crc32Update(payloadCrc, chunk)
    let off = 0

    while (off < chunk.length) {
      emitEmptySections()

      if (sectionId >= directory.length) {
        streamOffset += chunk.length - off
        return
      }

      const entry = directory[sectionId]
      if (streamOffset < entry.fileOffset) {
        const skip = Math.min(entry.fileOffset - streamOffset, chunk.length - off)
        streamOffset += skip
        off += skip
        continue
      }

      if (current == null) {
        current = Buffer.allocUnsafe(entry.uncompressedLength)
      }

      const written = streamOffset - entry.fileOffset
      const take = Math.min(entry.uncompressedLength - written, chunk.length - off)
      chunk.copy(current, written, off, off + take)
      streamOffset += take
      off += take

      if (written + take === entry.uncompressedLength) {
        verifySectionCrc(current, entry.sectionCrc32)
        sections[sectionId] = current
        current = null
        sectionId++
      }
    }
  }

  function finish(): void {
    emitEmptySections()
    if (streamOffset !== uncompressedLength || sectionId !== directory.length) {
      throw new Error(MSV5_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    if (payloadCrc !== payloadCrc32) {
      throw new Error('MSv5 payload CRC mismatch')
    }
  }

  return { sections, consume, finish }
}

function loadMsv5SectionsFromZstdStream(
  compressed: Buffer,
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
): Promise<Buffer[]> {
  return loadMsv5SectionsFromCompressedStream(
    compressed,
    directory,
    uncompressedLength,
    payloadCrc32,
    () => zlib.createZstdDecompress(),
  )
}

function loadMsv5SectionsFromZlibStream(
  compressed: Buffer,
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
): Promise<Buffer[]> {
  return loadMsv5SectionsFromCompressedStream(
    compressed,
    directory,
    uncompressedLength,
    payloadCrc32,
    () => zlib.createInflate(),
  )
}

function loadMsv5SectionsFromCompressedStream(
  compressed: Buffer,
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
  createStream: () => Transform,
): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const collector = collectCompressedPayloadSections(directory, uncompressedLength, payloadCrc32)
    const stream = createStream()
    stream.on('data', (chunk: Buffer) => {
      try {
        collector.consume(chunk)
      } catch (err) {
        stream.destroy(err as Error)
      }
    })
    stream.on('error', reject)
    stream.on('end', () => {
      try {
        collector.finish()
        resolve(collector.sections)
      } catch (err) {
        reject(err)
      }
    })
    stream.end(compressed)
  })
}

function validatePayloadDirectory(
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
): void {
  let prevEnd = 0
  for (const entry of directory) {
    if ((entry.fileOffset & 3) !== 0) {
      throw new Error('MSv5 section offset not aligned')
    }
    if (entry.fileOffset < prevEnd) {
      throw new Error('MSv5 section offsets not monotonic')
    }
    if (entry.fileOffset + entry.uncompressedLength > uncompressedLength) {
      throw new Error('MSv5 section out of uncompressed bounds')
    }
    prevEnd = entry.fileOffset + entry.uncompressedLength
  }
  if (prevEnd !== uncompressedLength) {
    throw new Error('MSv5 uncompressed payload length mismatch')
  }
}

interface PreparedPayload {
  payloadCodec: number
  slice: Buffer
  uncompressedLength: number
  payloadCrc32: number
}

/** Shared validation + bounds for both the sync and async load paths. */
function preparePayload(fileBuf: Buffer, directory: Msv5SectionEntry[]): PreparedPayload {
  assertPayloadFormatRev(fileBuf)
  const { payloadOffset, compressedLength, uncompressedLength, payloadCrc32, payloadCodec }
    = readPayloadMeta(fileBuf)
  validatePayloadDirectory(directory, uncompressedLength)

  if (payloadOffset !== MSV5_HEADER_SIZE || payloadOffset + compressedLength > fileBuf.length) {
    throw new Error('MSv5 payload out of bounds')
  }
  if (payloadCodec === CODEC_RAW && compressedLength !== uncompressedLength) {
    throw new Error('MSv5 raw payload length mismatch')
  }

  return {
    payloadCodec,
    slice: fileBuf.subarray(payloadOffset, payloadOffset + compressedLength),
    uncompressedLength,
    payloadCrc32,
  }
}

function decompressPayloadSync(
  payloadCodec: number,
  slice: Buffer,
  uncompressedLength: number,
): Buffer {
  if (payloadCodec === CODEC_ZSTD) {
    if (!zstdAvailable()) {
      throw zstdUnavailableReadError()
    }
    const decoded = zlib.zstdDecompressSync(slice, {
      maxOutputLength: MSV5_MAX_UNCOMPRESSED_BYTES,
    })
    if (decoded.length !== uncompressedLength) {
      throw new Error(MSV5_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    return decoded
  }
  if (payloadCodec === CODEC_ZLIB) {
    const decoded = zlib.inflateSync(slice, {
      maxOutputLength: MSV5_MAX_UNCOMPRESSED_BYTES,
    })
    if (decoded.length !== uncompressedLength) {
      throw new Error(MSV5_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    return decoded
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
}

/** Synchronous load; peak RAM ≈ full uncompressed payload (use the async path to bound it). */
export function loadMsv5Sections(
  fileBuf: Buffer,
  directory: Msv5SectionEntry[],
): Buffer[] {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = preparePayload(fileBuf, directory)

  if (payloadCodec === CODEC_RAW) {
    return sectionsFromPayload(slice, directory, payloadCrc32)
  }
  const decoded = decompressPayloadSync(payloadCodec, slice, uncompressedLength)
  return sectionsFromPayload(decoded, directory, payloadCrc32)
}

/** Streaming load; peak main-thread RAM ≈ largest single section (+ file buffer). */
export async function loadMsv5SectionsAsync(
  fileBuf: Buffer,
  directory: Msv5SectionEntry[],
): Promise<Buffer[]> {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = preparePayload(fileBuf, directory)

  if (payloadCodec === CODEC_RAW) {
    return sectionsFromPayload(slice, directory, payloadCrc32)
  }
  if (payloadCodec === CODEC_ZSTD) {
    if (!zstdAvailable()) {
      throw zstdUnavailableReadError()
    }
    return loadMsv5SectionsFromZstdStream(slice, directory, uncompressedLength, payloadCrc32)
  }
  if (payloadCodec === CODEC_ZLIB) {
    return loadMsv5SectionsFromZlibStream(slice, directory, uncompressedLength, payloadCrc32)
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
}

export function isMsv5Buffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.toString('ascii', 0, 4) === 'MSv5'
}

export function readMsv5GlobalFlags(buf: Buffer): number {
  return buf.readUInt16LE(6)
}
