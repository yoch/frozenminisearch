/**
 * Wildcard query symbol (matches all documents).
 * Use {@link FrozenMiniSearch.wildcard} in application code.
 */
export const WILDCARD_QUERY: unique symbol = Symbol('*')

/** True only for this package's wildcard symbol (strict identity, not description). */
export function isWildcardQuery(query: unknown): boolean {
  return query === WILDCARD_QUERY
}
