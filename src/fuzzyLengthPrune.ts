/**
 * Length bounds for fuzzy radix traversal (B1).
 * Only prunes when the dictionary prefix cannot be a prefix of any match.
 */

/**
 * @param prefixLen Dictionary characters on the path before this edge
 * @param edgeLen Compressed edge label length
 */
export function shouldPruneFuzzyEdge(
  prefixLen: number,
  edgeLen: number,
  queryLen: number,
  maxDistance: number,
): boolean {
  return prefixLen + edgeLen > queryLen + maxDistance
}
