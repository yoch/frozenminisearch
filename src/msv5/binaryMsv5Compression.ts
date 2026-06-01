import {
  constants as zlibConstants,
  createZstdDecompress,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'
import { crc32Buffer, crc32Update } from '../binaryIo'
import {
  CODEC_RAW,
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
  zstdCompressionWorthKeeping,
} from './binaryMsv5Constants'

export { zstdCompressionWorthKeeping } from './binaryMsv5Constants'

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

/** Hard cap on the uncompressed payload, rejected before allocation (zstd-bomb guard). */
const MSV5_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024

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

function choosePayloadCodec(uncompressed: Buffer): {
  payload: Buffer
  codec: number
  zstdLevel: number
} {
  if (uncompressed.length < MSV5_MIN_COMPRESS_BYTES) {
    return { payload: uncompressed, codec: CODEC_RAW, zstdLevel: 0 }
  }
  const compressed = zstdCompressSync(uncompressed, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: MSV5_ZSTD_LEVEL,
    },
  })
  if (zstdCompressionWorthKeeping(compressed.length, uncompressed.length)) {
    return { payload: compressed, codec: CODEC_ZSTD, zstdLevel: MSV5_ZSTD_LEVEL }
  }
  return { payload: uncompressed, codec: CODEC_RAW, zstdLevel: 0 }
}

/**
 * MSv5 on disk: header + catalogue (uncompressed offsets) + **one** payload blob
 * (raw concatenation or a single zstd stream over it).
 */
export function assembleMsv5File(
  globalFlags: number,
  rawSections: Buffer[],
): Msv5AssembledFile {
  if (rawSections.length !== MSV5_SECTION_COUNT) {
    throw new Error(`MSv5 expects ${MSV5_SECTION_COUNT} sections, got ${rawSections.length}`)
  }

  const { uncompressed, entries } = concatRawSections(rawSections)
  if (uncompressed.length > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error('MSv5 payload exceeds 1 GiB limit')
  }
  const payloadCrc32 = crc32Buffer(uncompressed)
  const { payload, codec, zstdLevel } = choosePayloadCodec(uncompressed)

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
  out.writeUInt32LE(uncompressed.length, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
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
      uncompressedLength: uncompressed.length,
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

/** Streaming zstd reader: keeps only one section in memory at a time. */
function collectZstdPayloadSections(
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
      throw new Error('MSv5 zstd payload exceeds declared length')
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
      throw new Error('MSv5 zstd decompressed length mismatch')
    }
    if (payloadCrc !== payloadCrc32) {
      throw new Error('MSv5 payload CRC mismatch')
    }
  }

  return { sections, consume, finish }
}

export function loadMsv5SectionsFromZstdStream(
  compressed: Buffer,
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const collector = collectZstdPayloadSections(directory, uncompressedLength, payloadCrc32)
    const stream = createZstdDecompress()
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
  const { payloadOffset, compressedLength, uncompressedLength, payloadCrc32, payloadCodec } =
    readPayloadMeta(fileBuf)
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

/** Synchronous load; peak RAM ≈ full uncompressed payload (use the async path to bound it). */
export function loadMsv5Sections(
  fileBuf: Buffer,
  directory: Msv5SectionEntry[],
): Buffer[] {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = preparePayload(fileBuf, directory)

  if (payloadCodec === CODEC_RAW) {
    return sectionsFromPayload(slice, directory, payloadCrc32)
  }
  if (payloadCodec === CODEC_ZSTD) {
    const decoded = zstdDecompressSync(slice)
    if (decoded.length !== uncompressedLength) {
      throw new Error('MSv5 zstd decompressed length mismatch')
    }
    return sectionsFromPayload(decoded, directory, payloadCrc32)
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
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
    return loadMsv5SectionsFromZstdStream(slice, directory, uncompressedLength, payloadCrc32)
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
}

export function isMsv5Buffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.toString('ascii', 0, 4) === 'MSv5'
}

export function readMsv5GlobalFlags(buf: Buffer): number {
  return buf.readUInt16LE(6)
}
