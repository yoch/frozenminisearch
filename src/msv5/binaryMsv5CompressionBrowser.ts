import {
  allocBytes,
  readAscii,
  readU8,
  readU16LE,
  readU32LE,
  writeAscii,
  writeU8,
  writeU16LE,
  writeU32LE,
  type BinaryBytes,
} from '../binaryBytes'
import { crc32Bytes } from '../crc32Wire'
import type { BrowserBinaryCompression } from '../searchTypes'
import type { Msv5SectionEntry, Msv5SnapshotCompressionMeta } from './binaryMsv5Types'
import {
  CODEC_RAW,
  CODEC_ZSTD,
  CODEC_ZLIB,
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
  MSV5_ZSTD_LEVEL_OFFSET,
} from './binaryMsv5Constants'
import { browserZlibDeflateSync, browserZlibInflateSync } from './compressionBrowser'
export type { Msv5SectionEntry, Msv5SnapshotCompressionMeta } from './binaryMsv5Types'

export interface Msv5AssembledFileBrowser {
  buffer: Uint8Array
  globalFlags: number
  compression: Msv5SnapshotCompressionMeta
}

const MSV5_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MSV5_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH = 'MSv5 decompressed payload length mismatch'

function zstdUnavailableWriteError(): Error {
  return new Error(
    'MSv5 snapshot requested zstd compression, which is not supported in the browser build. '
    + 'Use compression: "auto", "raw", or "zlib".',
  )
}

function zstdUnavailableReadError(): Error {
  return new Error(
    'MSv5 snapshot is zstd-compressed, which is not supported in the browser build. '
    + 'Re-save with compression: "raw" or "zlib".',
  )
}

function assertPayloadFormatRev(buf: BinaryBytes): void {
  const rev = readU16LE(buf, MSV5_FORMAT_REV_OFFSET)
  if (rev !== MSV5_FORMAT_REV_PAYLOAD) {
    throw new Error(`MSv5 unsupported format revision ${rev}`)
  }
}

interface PayloadCodecChoice {
  payload: BinaryBytes
  codec: number
  zstdLevel: number
}

function rawPayloadChoice(uncompressed: BinaryBytes): PayloadCodecChoice {
  return { payload: uncompressed, codec: CODEC_RAW, zstdLevel: 0 }
}

function pickAutoPayloadCodec(
  uncompressed: BinaryBytes,
  compressed: BinaryBytes,
  codec: number,
): PayloadCodecChoice {
  if (compressed.length < uncompressed.length) {
    return { payload: compressed, codec, zstdLevel: 0 }
  }
  return rawPayloadChoice(uncompressed)
}

function zlibPayloadChoiceSync(uncompressed: BinaryBytes): PayloadCodecChoice {
  return { payload: browserZlibDeflateSync(uncompressed), codec: CODEC_ZLIB, zstdLevel: 0 }
}

function autoPayloadChoice(uncompressed: BinaryBytes): PayloadCodecChoice {
  if (uncompressed.length < MSV5_MIN_COMPRESS_BYTES) {
    return rawPayloadChoice(uncompressed)
  }
  return pickAutoPayloadCodec(uncompressed, browserZlibDeflateSync(uncompressed), CODEC_ZLIB)
}

function choosePayloadCodecSync(
  uncompressed: BinaryBytes,
  compression: BrowserBinaryCompression | 'zstd' = 'auto',
): PayloadCodecChoice {
  if (compression === 'zstd') {
    throw zstdUnavailableWriteError()
  }
  switch (compression) {
    case 'raw':
      return rawPayloadChoice(uncompressed)
    case 'zlib':
      return zlibPayloadChoiceSync(uncompressed)
    case 'auto':
      return autoPayloadChoice(uncompressed)
    default: {
      const _exhaustive: never = compression
      return _exhaustive
    }
  }
}

function concatRawSections(rawSections: BinaryBytes[]): {
  uncompressed: BinaryBytes
  entries: Msv5SectionEntry[]
} {
  const entries: Msv5SectionEntry[] = []
  let uncompressedLength = 0

  for (const raw of rawSections) {
    uncompressedLength = (uncompressedLength + 3) & ~3
    entries.push({
      fileOffset: uncompressedLength,
      uncompressedLength: raw.length,
      sectionCrc32: crc32Bytes(raw),
    })
    uncompressedLength += raw.length
  }

  const uncompressed = allocBytes(uncompressedLength)
  for (let i = 0; i < rawSections.length; i++) {
    uncompressed.set(rawSections[i], entries[i].fileOffset)
  }

  return { uncompressed, entries }
}

function concatAndValidateSections(rawSections: BinaryBytes[]): {
  uncompressed: BinaryBytes
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
  return { uncompressed, entries, payloadCrc32: crc32Bytes(uncompressed) }
}

function buildMsv5AssembledFile(
  globalFlags: number,
  entries: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
  payload: BinaryBytes,
  codec: number,
  zstdLevel: number,
): Msv5AssembledFileBrowser {
  const out = allocBytes(MSV5_HEADER_SIZE + payload.length)
  writeAscii(out, 0, 'MSv5')
  writeU16LE(out, 4, 5)
  writeU16LE(out, 6, globalFlags & 0xffff)
  writeU8(out, MSV5_PAYLOAD_CODEC_OFFSET, codec)
  writeU8(out, MSV5_ZSTD_LEVEL_OFFSET, zstdLevel)
  writeU16LE(out, MSV5_FORMAT_REV_OFFSET, MSV5_FORMAT_REV_PAYLOAD)
  writeU32LE(out, MSV5_SECTION_COUNT_OFFSET, MSV5_SECTION_COUNT)
  writeU32LE(out, MSV5_PAYLOAD_COMPRESSED_OFFSET, MSV5_HEADER_SIZE)
  writeU32LE(out, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET, payload.length)
  writeU32LE(out, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET, uncompressedLength)
  writeU32LE(out, MSV5_PAYLOAD_CRC_OFFSET, payloadCrc32)

  let dirOff = MSV5_SECTION_DIR_OFFSET
  for (const entry of entries) {
    writeU32LE(out, dirOff, entry.fileOffset)
    writeU32LE(out, dirOff + 4, entry.uncompressedLength)
    writeU32LE(out, dirOff + 8, entry.sectionCrc32)
    dirOff += MSV5_SECTION_ENTRY_BYTES
  }

  out.set(payload, MSV5_HEADER_SIZE)

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

export function assembleMsv5FileBrowser(
  globalFlags: number,
  rawSections: BinaryBytes[],
  compression: BrowserBinaryCompression = 'auto',
): Msv5AssembledFileBrowser {
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

export function readMsv5SectionDirectory(buf: BinaryBytes): Msv5SectionEntry[] {
  if (buf.length < MSV5_HEADER_SIZE) {
    throw new Error('MSv5 buffer too short for header')
  }
  const sectionCount = readU32LE(buf, MSV5_SECTION_COUNT_OFFSET)
  if (sectionCount !== MSV5_SECTION_COUNT) {
    throw new Error(`MSv5 section count mismatch: ${sectionCount}`)
  }
  assertPayloadFormatRev(buf)
  const entries: Msv5SectionEntry[] = []
  let dirOff = MSV5_SECTION_DIR_OFFSET
  for (let i = 0; i < sectionCount; i++) {
    entries.push({
      fileOffset: readU32LE(buf, dirOff),
      uncompressedLength: readU32LE(buf, dirOff + 4),
      sectionCrc32: readU32LE(buf, dirOff + 8),
    })
    dirOff += MSV5_SECTION_ENTRY_BYTES
  }
  return entries
}

export function readMsv5SnapshotCompressionMetaBrowser(buf: BinaryBytes): Msv5SnapshotCompressionMeta {
  const directory = readMsv5SectionDirectory(buf)
  return {
    formatRev: MSV5_FORMAT_REV_PAYLOAD,
    payloadCodec: readU8(buf, MSV5_PAYLOAD_CODEC_OFFSET),
    zstdLevel: readU8(buf, MSV5_ZSTD_LEVEL_OFFSET),
    uncompressedLength: readU32LE(buf, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET),
    compressedLength: readU32LE(buf, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET),
    payloadCrc32: readU32LE(buf, MSV5_PAYLOAD_CRC_OFFSET),
    sections: directory.map((e, sectionId) => ({
      sectionId,
      uncompressedOffset: e.fileOffset,
      uncompressedLength: e.uncompressedLength,
      sectionCrc32: e.sectionCrc32,
    })),
  }
}

function verifySectionCrc(section: BinaryBytes, expected: number): void {
  if (crc32Bytes(section) !== expected) {
    throw new Error('MSv5 section CRC mismatch')
  }
}

function sectionsFromPayload(
  payload: BinaryBytes,
  directory: Msv5SectionEntry[],
  payloadCrc32: number,
): BinaryBytes[] {
  if (crc32Bytes(payload) !== payloadCrc32) {
    throw new Error('MSv5 payload CRC mismatch')
  }
  return directory.map((entry) => {
    const slice = payload.subarray(entry.fileOffset, entry.fileOffset + entry.uncompressedLength)
    verifySectionCrc(slice, entry.sectionCrc32)
    if ((payload.byteOffset + entry.fileOffset) % 4 === 0) return slice
    const out = allocBytes(entry.uncompressedLength)
    out.set(slice)
    return out
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

function preparePayload(fileBuf: BinaryBytes, directory: Msv5SectionEntry[]): {
  payloadCodec: number
  slice: BinaryBytes
  uncompressedLength: number
  payloadCrc32: number
} {
  assertPayloadFormatRev(fileBuf)
  const payloadOffset = readU32LE(fileBuf, MSV5_PAYLOAD_COMPRESSED_OFFSET)
  const compressedLength = readU32LE(fileBuf, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
  const uncompressedLength = readU32LE(fileBuf, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
  const payloadCrc32 = readU32LE(fileBuf, MSV5_PAYLOAD_CRC_OFFSET)
  const payloadCodec = readU8(fileBuf, MSV5_PAYLOAD_CODEC_OFFSET)
  if (uncompressedLength > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error('MSv5 payload exceeds 1 GiB limit')
  }
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
  slice: BinaryBytes,
  uncompressedLength: number,
): BinaryBytes {
  if (payloadCodec === CODEC_ZSTD) {
    throw zstdUnavailableReadError()
  }
  if (payloadCodec === CODEC_ZLIB) {
    const decoded = browserZlibInflateSync(slice)
    if (decoded.length !== uncompressedLength) {
      throw new Error(MSV5_DECOMPRESSED_PAYLOAD_LENGTH_MISMATCH)
    }
    return decoded
  }
  throw new Error(`MSv5 unknown payload codec ${payloadCodec}`)
}

export function loadMsv5SectionsBrowser(
  fileBuf: BinaryBytes,
  directory: Msv5SectionEntry[],
): BinaryBytes[] {
  const { payloadCodec, slice, uncompressedLength, payloadCrc32 } = preparePayload(fileBuf, directory)

  if (payloadCodec === CODEC_RAW) {
    return sectionsFromPayload(slice, directory, payloadCrc32)
  }
  const decoded = decompressPayloadSync(payloadCodec, slice, uncompressedLength)
  return sectionsFromPayload(decoded, directory, payloadCrc32)
}

export function isMsv5Bytes(buf: BinaryBytes): boolean {
  return buf.length >= 4 && readAscii(buf, 0, 4) === 'MSv5'
}

export function readMsv5GlobalFlagsBrowser(buf: BinaryBytes): number {
  return readU16LE(buf, 6)
}
