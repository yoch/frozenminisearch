/** MSv5 unified frozen snapshot (columnar tree, single payload zstd stream). */
export const BINARY_MAGIC_V5 = 'MSv5'
export const BINARY_VERSION_V5 = 5

/** Postings / field-length flags (low 16 bits of global flags at offset 6). */
export const FLAG_DOC_ID_16 = 1
export const FLAG_SPARSE_LAYOUT = 2
export const FLAG_FIELD_ID_16 = 4
export const FLAG_FL_U8 = 8
export const FLAG_FL_U16 = 16
export const FLAG_FREQ_U16 = 32

export const CODEC_RAW = 0
/** Zstandard (`node:zlib`) on the whole payload. */
export const CODEC_ZSTD = 3

/** Single concatenated payload, one zstd stream (or raw). */
export const MSV5_FORMAT_REV_PAYLOAD = 1

/** Do not compress payloads smaller than this (bytes). */
export const MSV5_MIN_COMPRESS_BYTES = 64
/** Fixed zstd compression level for the whole payload. */
export const MSV5_ZSTD_LEVEL = 9

export const MSV5_SECTION_COUNT = 12
/** Per-section catalogue entry: fileOffset(4) + uncompressedLength(4) + crc32(4) + reserved(8). */
export const MSV5_SECTION_ENTRY_BYTES = 20

/** magic(4) + version(2) + indexFlags(2) + payloadMeta(4) + formatRev(2) + sectionCount(4) */
export const MSV5_HEADER_PREFIX_SIZE = 32
export const MSV5_HEADER_SIZE = MSV5_HEADER_PREFIX_SIZE + MSV5_SECTION_COUNT * MSV5_SECTION_ENTRY_BYTES

export const MSV5_PAYLOAD_CODEC_OFFSET = 8
export const MSV5_ZSTD_LEVEL_OFFSET = 9
export const MSV5_FORMAT_REV_OFFSET = 10
export const MSV5_SECTION_COUNT_OFFSET = 12

/** compressedOffset, compressedLength, uncompressedLength, payloadCrc32 (each u32). */
export const MSV5_PAYLOAD_COMPRESSED_OFFSET = 16
export const MSV5_PAYLOAD_COMPRESSED_LENGTH_OFFSET = 20
export const MSV5_PAYLOAD_UNCOMPRESSED_LENGTH_OFFSET = 24
export const MSV5_PAYLOAD_CRC_OFFSET = 28

export const MSV5_SECTION_DIR_OFFSET = MSV5_HEADER_PREFIX_SIZE

export const enum Msv5SectionId {
  Core = 0,
  FieldNames = 1,
  ExternalIds = 2,
  StoredFields = 3,
  TermTree = 4,
  AvgFieldLength = 5,
  FieldLengthMatrix = 6,
  PostMeta = 7,
  PostFields = 8,
  PostOptional = 9,
  AllDocIds = 10,
  AllFreqs = 11,
}

/** Tree column order for columnWidthFlags bit pairs (2 bits each). */
export const MSV5_TREE_COLUMN_COUNT = 6
