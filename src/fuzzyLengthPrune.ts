/**
 * Length bounds for fuzzy radix traversal (B1).
 * Only prunes when the dictionary prefix cannot be a prefix of any match.
 */

/** Dictionary prefix length already exceeds any term within edit distance k. */
export function isDictPrefixTooLong (
  dictPrefixLen: number,
  queryLen: number,
  maxDistance: number,
): boolean {
  return dictPrefixLen > queryLen + maxDistance
}

/**
 * @param prefixLen Dictionary characters on the path before this edge
 * @param edgeLen Compressed edge label length
 */
export function shouldPruneFuzzyEdge (
  prefixLen: number,
  edgeLen: number,
  queryLen: number,
  maxDistance: number,
): boolean {
  return isDictPrefixTooLong(prefixLen + edgeLen, queryLen, maxDistance)
}
