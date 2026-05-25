import MiniSearch from './MiniSearch'

export * from './MiniSearch'
export {
  default as FrozenMiniSearch,
  buildFrozenFromDocuments,
  freezeFromMiniSearch,
  frozenMemoryBreakdown,
  assembleFrozen,
  type FrozenAssembleParams,
  type FrozenMemoryBreakdown
} from './FrozenMiniSearch'
export default MiniSearch
