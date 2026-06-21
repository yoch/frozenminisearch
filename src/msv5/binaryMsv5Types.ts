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
