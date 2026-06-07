export { OR, AND, AND_NOT } from './scoring'
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
} from './searchTypes'
export {
  default,
  buildFrozenFromDocuments,
  freezeFrozenIndexBuilder,
  frozenMemoryBreakdown,
  assembleFrozen,
  type FrozenAssembleParams,
  type FrozenMemoryBreakdown,
  type MiniSearchSnapshot,
} from './FrozenMiniSearch'
export type { SerializedIndexEntry } from './fromMiniSearch'
export {
  createFrozenIndexBuilder,
  FrozenIndexBuilder,
  type FrozenIndexBuilderHints,
} from './frozenBuild'
