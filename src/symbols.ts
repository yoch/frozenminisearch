/**
 * Wildcard query symbol (matches all documents).
 * Prefer {@link MiniSearch.wildcard} or {@link FrozenMiniSearch.wildcard} in application code.
 */
export const WILDCARD_QUERY: unique symbol = Symbol('*')
