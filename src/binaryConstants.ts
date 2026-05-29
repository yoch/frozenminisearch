export const BINARY_MAGIC_V3 = 'MSv3'
export const BINARY_VERSION_V3 = 3
export const BINARY_MAGIC_V4 = 'MSv4'
export const BINARY_VERSION_V4 = 4

/** MSv3: dense Uint32 postings, no dictionary section (termCount in 16-byte core). */
export const HEADER_SIZE_V3 = 60
/** MSv4: sparse / Uint16 flags, no dictionary section (termCount in 16-byte core). */
export const HEADER_SIZE_V4 = 68

export const FLAG_DOC_ID_16 = 1
export const FLAG_SPARSE_LAYOUT = 2
export const FLAG_FIELD_ID_16 = 4

export const ID_TAG_EMPTY = 0
export const ID_TAG_NUMBER = 1
export const ID_TAG_STRING = 2
export const ID_TAG_JSON = 3

export const TREE_NODE_LEAF = 0
export const TREE_NODE_EDGE = 1
