export { OR, AND, AND_NOT } from './scoring'
export { finalizeRawSearchResults, finalizeSearchResults } from './scoring'
export { suggestFromRawResults, suggestFromSearchResults } from './suggestions'
export type {
  BM25Params,
  LowercaseCombinationOperator,
  CombinationOperator,
  LogLevel,
  SearchOptions,
  Options,
  Suggestion,
  MatchInfo,
  SearchResult,
  QueryCombination,
  Wildcard,
  Query,
  BrowserBinaryCompression,
  BrowserSaveBinaryAsyncOptions,
} from './searchTypes'
export {
  default,
  default as FrozenMiniSearch,
  assembleFrozen,
} from './FrozenMiniSearchBrowser'
export type { FrozenAssembleParams, FrozenMemoryBreakdown } from './frozenTypes'
export type { MiniSearchSnapshot } from './fromMiniSearch'
export type { SerializedIndexEntry } from './fromMiniSearch'
export {
  createFrozenIndexBuilder,
  FrozenIndexBuilder,
  type FrozenIndexBuilderHints,
} from './frozenBuild'
export { frozenMemoryBreakdown } from './FrozenMiniSearchCore'
import FrozenMiniSearchBrowser from './FrozenMiniSearchBrowser'
import { assembleFrozenWithCtor } from './FrozenMiniSearchCore'
import { buildFrozenParamsFromDocuments, type FrozenIndexBuilder } from './frozenBuild'
import type { Options } from './searchTypes'

export function buildFrozenFromDocuments<T>(
  documents: readonly T[],
  options: Options<T>,
): FrozenMiniSearchBrowser<T> {
  return assembleFrozenWithCtor(
    buildFrozenParamsFromDocuments(documents, options),
    true,
    'trusted-build',
    FrozenMiniSearchBrowser,
  )
}

export function freezeFrozenIndexBuilder<T>(
  builder: FrozenIndexBuilder<T>,
): FrozenMiniSearchBrowser<T> {
  return assembleFrozenWithCtor(builder.freezeParams(), true, 'trusted-build', FrozenMiniSearchBrowser)
}
