/** Sentinel stored in `nodeValue` / `nodeLeafOrder` when a node carries no leaf. */
export const PACKED_NO_VALUE = 0xffffffff

/** Max UTF-16 length of a single edge label (`edgeLabelLength` is a `Uint16Array`). */
export const MAX_PACKED_EDGE_LABEL_LENGTH = 0xffff
