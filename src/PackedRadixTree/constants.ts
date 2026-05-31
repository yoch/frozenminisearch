/**
 * Build-time scratch marker for "node carries no leaf" while assembling a tree
 * from a mutable `RadixTree` or a decoded binary section. It is *not* stored in
 * the packed arrays: there, the absence of a leaf is encoded by
 * `nodeLeafOrder === 0` (see {@link PackedRadixTreeData.nodeLeafOrder}), which
 * frees `nodeValue` from carrying a sentinel and lets both columns use the
 * narrowest typed array.
 */
export const PACKED_NO_VALUE = 0xffffffff

/** Max UTF-16 length of a single edge label. */
export const MAX_PACKED_EDGE_LABEL_LENGTH = 0xffff
