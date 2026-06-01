/**
 * @deprecated MSv3 is deprecated; {@link FrozenMiniSearch.saveBinarySync} writes MSv5. Still readable via {@link FrozenMiniSearch.loadBinarySync}.
 */
export const BINARY_MAGIC_V3 = 'MSv3'
/** @deprecated MSv3 is deprecated; use MSv5 (version 5). */
export const BINARY_VERSION_V3 = 3
/**
 * @deprecated MSv4 is deprecated; {@link FrozenMiniSearch.saveBinarySync} writes MSv5. Still readable via {@link FrozenMiniSearch.loadBinarySync}.
 */
export const BINARY_MAGIC_V4 = 'MSv4'
/** @deprecated MSv4 is deprecated; use MSv5 (version 5). */
export const BINARY_VERSION_V4 = 4

/** @deprecated MSv3 on-disk header size; MSv5 uses a different layout. */
export const HEADER_SIZE_V3 = 60
/** @deprecated MSv4 on-disk header size; MSv5 uses a different layout. */
export const HEADER_SIZE_V4 = 68

export const FLAG_DOC_ID_16 = 1
export const FLAG_SPARSE_LAYOUT = 2
export const FLAG_FIELD_ID_16 = 4

export const ID_TAG_EMPTY = 0
export const ID_TAG_NUMBER = 1
export const ID_TAG_STRING = 2
export const ID_TAG_JSON = 3

/** @deprecated MSv3/MSv4 recursive DFS term-tree node tag; MSv5 uses columnar layout. */
export const TREE_NODE_LEAF = 0
/** @deprecated MSv3/MSv4 recursive DFS term-tree node tag; MSv5 uses columnar layout. */
export const TREE_NODE_EDGE = 1
