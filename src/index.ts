import MiniSearch from './MiniSearch'

export * from './MiniSearch'
export {
  default as FrozenMiniSearch,
  buildFrozenFromDocuments,
  freezeFromMiniSearch,
  freezeFrozenIndexBuilder,
  frozenMemoryBreakdown,
  assembleFrozen,
  type FrozenAssembleParams,
  type FrozenMemoryBreakdown,
} from './FrozenMiniSearch'
export {
  createFrozenIndexBuilder,
  FrozenIndexBuilder,
  type FrozenIndexBuilderHints,
} from './frozenBuild'
export default MiniSearch
