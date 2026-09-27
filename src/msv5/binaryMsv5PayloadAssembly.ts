import type { BinaryBytes } from '../binaryBytes'
import { crc32Update as crc32UpdateWire } from '../crc32Wire'
import type { Msv5SectionEntry } from './binaryMsv5Types'

/** Incremental CRC-32 IEEE update; Node passes the native `zlib.crc32` wrapper, browsers the JS table. */
export type Crc32UpdateFn = (seed: number, buf: BinaryBytes, start?: number, end?: number) => number

export function computeSectionDirectory(
  rawSections: BinaryBytes[],
  crc32Update: Crc32UpdateFn = crc32UpdateWire,
): {
  entries: Msv5SectionEntry[]
  uncompressedLength: number
} {
  const entries: Msv5SectionEntry[] = []
  let uncompressedLength = 0

  for (const raw of rawSections) {
    uncompressedLength = (uncompressedLength + 3) & ~3
    entries.push({
      fileOffset: uncompressedLength,
      uncompressedLength: raw.length,
      sectionCrc32: crc32Update(0, raw),
    })
    uncompressedLength += raw.length
  }

  return { entries, uncompressedLength }
}

/** Copy aligned sections into a payload region and fold their bytes into one payload CRC.
 *  `dest` must be zero-initialised on `[payloadStart, payloadStart + uncompressedLength)`. */
export function writeRawSectionsIntoPayload(
  dest: BinaryBytes,
  payloadStart: number,
  rawSections: BinaryBytes[],
  entries: Msv5SectionEntry[],
  crc32Update: Crc32UpdateFn = crc32UpdateWire,
): number {
  let payloadCrc32 = 0
  let coveredEnd = 0

  for (let i = 0; i < rawSections.length; i++) {
    const entry = entries[i]
    const gapStart = payloadStart + coveredEnd
    const sectionStart = payloadStart + entry.fileOffset
    if (sectionStart > gapStart) {
      payloadCrc32 = crc32Update(payloadCrc32, dest, gapStart, sectionStart)
    }
    dest.set(rawSections[i], sectionStart)
    payloadCrc32 = crc32Update(payloadCrc32, rawSections[i])
    coveredEnd = entry.fileOffset + entry.uncompressedLength
  }

  return payloadCrc32
}

export function concatRawSectionsWithCrc(
  rawSections: BinaryBytes[],
  alloc: (size: number) => BinaryBytes,
  crc32Update: Crc32UpdateFn = crc32UpdateWire,
): {
  uncompressed: BinaryBytes
  entries: Msv5SectionEntry[]
  payloadCrc32: number
} {
  const { entries, uncompressedLength } = computeSectionDirectory(rawSections, crc32Update)
  const uncompressed = alloc(uncompressedLength)
  const payloadCrc32 = writeRawSectionsIntoPayload(uncompressed, 0, rawSections, entries, crc32Update)
  return { uncompressed, entries, payloadCrc32 }
}
