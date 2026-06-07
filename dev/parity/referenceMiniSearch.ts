/**
 * Build comparable reference (lucaong minisearch) + frozen pair for parity tests.
 */
import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'
import type { Options } from '../../src/searchTypes'

export function buildComparablePair<T>(docs: readonly T[], options: Options<T>) {
  const reference = new MiniSearch(options)
  reference.addAll(docs)
  const frozen = FrozenMiniSearch.fromMiniSearch(reference, options)
  return { reference, frozen }
}

export function buildFrozenFromDocuments<T>(docs: readonly T[], options: Options<T>) {
  return FrozenMiniSearch.fromDocuments(docs, options)
}

export { MiniSearch }
