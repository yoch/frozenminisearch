import {
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
import {
  CODEC_RAW,
  MSV5_ERR_BUFFER_TOO_SHORT_FOR_HEADER,
  MSV5_ERR_PAYLOAD_EXCEEDS_1GIB,
  MSV5_ERR_PAYLOAD_OUT_OF_BOUNDS,
  MSV5_ERR_RAW_PAYLOAD_LENGTH,
  MSV5_ERR_SECTION_OFFSETS_NOT_MONOTONIC,
  MSV5_ERR_SECTION_OFFSET_NOT_ALIGNED,
  MSV5_ERR_SECTION_OUT_OF_BOUNDS,
  MSV5_ERR_UNCOMPRESSED_PAYLOAD_LENGTH,
  MSV5_FORMAT_REV_OFFSET,
  MSV5_FORMAT_REV_PAYLOAD,
  MSV5_HEADER_SIZE,
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
import type { Msv5SectionEntry, Msv5SnapshotCompressionMeta } from './binaryMsv5Types'

export const MSV5_MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024

export interface PreparedMsv5Payload {
  payloadCodec: number
  slice: BinaryBytes
  uncompressedLength: number
  payloadCrc32: number
}

export function assertPayloadFormatRev(buf: BinaryBytes): void {
  const rev = readU16LE(buf, MSV5_FORMAT_REV_OFFSET)
  if (rev !== MSV5_FORMAT_REV_PAYLOAD) {
    throw new Error(`MSv5 unsupported format revision ${rev}`)
  }
}

export function assertRawSectionCount(rawSections: readonly BinaryBytes[]): void {
  if (rawSections.length !== MSV5_SECTION_COUNT) {
    throw new Error(`MSv5 expects ${MSV5_SECTION_COUNT} sections, got ${rawSections.length}`)
  }
}

export function buildMsv5CompressionMeta(
  entries: Msv5SectionEntry[],
  uncompressedLength: number,
  compressedLength: number,
  payloadCrc32: number,
  codec: number,
  zstdLevel: number,
): Msv5SnapshotCompressionMeta {
  return {
    formatRev: MSV5_FORMAT_REV_PAYLOAD,
    payloadCodec: codec,
    zstdLevel,
    uncompressedLength,
    compressedLength,
    payloadCrc32,
    sections: entries.map((e, sectionId) => ({
      sectionId,
      uncompressedOffset: e.fileOffset,
      uncompressedLength: e.uncompressedLength,
      sectionCrc32: e.sectionCrc32,
    })),
  }
}

export function writeMsv5FileHeader(
  out: BinaryBytes,
  globalFlags: number,
  entries: Msv5SectionEntry[],
  uncompressedLength: number,
  payloadCrc32: number,
  compressedLength: number,
  codec: number,
  zstdLevel: number,
): void {
  writeAscii(out, 0, 'MSv5')
  writeU16LE(out, 4, 5)
  writeU16LE(out, 6, globalFlags & 0xffff)
  writeU8(out, MSV5_PAYLOAD_CODEC_OFFSET, codec)
  writeU8(out, MSV5_ZSTD_LEVEL_OFFSET, zstdLevel)
  writeU16LE(out, MSV5_FORMAT_REV_OFFSET, MSV5_FORMAT_REV_PAYLOAD)
  writeU32LE(out, MSV5_SECTION_COUNT_OFFSET, MSV5_SECTION_COUNT)
  writeU32LE(out, MSV5_PAYLOAD_COMPRESSED_OFFSET, MSV5_HEADER_SIZE)
  writeU32LE(out, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET, compressedLength)
  writeU32LE(out, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET, uncompressedLength)
  writeU32LE(out, MSV5_PAYLOAD_CRC_OFFSET, payloadCrc32)

  let dirOff = MSV5_SECTION_DIR_OFFSET
  for (const entry of entries) {
    writeU32LE(out, dirOff, entry.fileOffset)
    writeU32LE(out, dirOff + 4, entry.uncompressedLength)
    writeU32LE(out, dirOff + 8, entry.sectionCrc32)
    dirOff += MSV5_SECTION_ENTRY_BYTES
  }
}

export function readMsv5SectionDirectory(buf: BinaryBytes): Msv5SectionEntry[] {
  if (buf.length < MSV5_HEADER_SIZE) {
    throw new Error(MSV5_ERR_BUFFER_TOO_SHORT_FOR_HEADER)
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

export function readMsv5SnapshotCompressionMeta(buf: BinaryBytes): Msv5SnapshotCompressionMeta {
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

export function validatePayloadDirectory(
  directory: Msv5SectionEntry[],
  uncompressedLength: number,
): void {
  let prevEnd = 0
  for (const entry of directory) {
    if ((entry.fileOffset & 3) !== 0) {
      throw new Error(MSV5_ERR_SECTION_OFFSET_NOT_ALIGNED)
    }
    if (entry.fileOffset < prevEnd) {
      throw new Error(MSV5_ERR_SECTION_OFFSETS_NOT_MONOTONIC)
    }
    if (entry.fileOffset + entry.uncompressedLength > uncompressedLength) {
      throw new Error(MSV5_ERR_SECTION_OUT_OF_BOUNDS)
    }
    prevEnd = entry.fileOffset + entry.uncompressedLength
  }
  if (prevEnd !== uncompressedLength) {
    throw new Error(MSV5_ERR_UNCOMPRESSED_PAYLOAD_LENGTH)
  }
}

export function preparePayload(fileBuf: BinaryBytes, directory: Msv5SectionEntry[]): PreparedMsv5Payload {
  assertPayloadFormatRev(fileBuf)
  const payloadOffset = readU32LE(fileBuf, MSV5_PAYLOAD_COMPRESSED_OFFSET)
  const compressedLength = readU32LE(fileBuf, MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET)
  const uncompressedLength = readU32LE(fileBuf, MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET)
  const payloadCrc32 = readU32LE(fileBuf, MSV5_PAYLOAD_CRC_OFFSET)
  const payloadCodec = readU8(fileBuf, MSV5_PAYLOAD_CODEC_OFFSET)
  if (uncompressedLength > MSV5_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(MSV5_ERR_PAYLOAD_EXCEEDS_1GIB)
  }
  validatePayloadDirectory(directory, uncompressedLength)

  if (payloadOffset !== MSV5_HEADER_SIZE || payloadOffset + compressedLength > fileBuf.length) {
    throw new Error(MSV5_ERR_PAYLOAD_OUT_OF_BOUNDS)
  }
  if (payloadCodec === CODEC_RAW && compressedLength !== uncompressedLength) {
    throw new Error(MSV5_ERR_RAW_PAYLOAD_LENGTH)
  }

  return {
    payloadCodec,
    slice: fileBuf.subarray(payloadOffset, payloadOffset + compressedLength),
    uncompressedLength,
    payloadCrc32,
  }
}

export function isMsv5Bytes(buf: BinaryBytes): boolean {
  return buf.length >= 4 && readAscii(buf, 0, 4) === 'MSv5'
}

export function readMsv5GlobalFlags(buf: BinaryBytes): number {
  return readU16LE(buf, 6)
}
