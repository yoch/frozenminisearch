import type { IdToShortIdLookup } from './frozenIdLookup'

/** Symbol key for internal corpus-binding lookup across Node and browser builds. */
export const VECTOR_CORPUS_BINDING = Symbol.for(
  '@yoch/frozenminisearch/vectorCorpusBinding',
)

/** Snapshot topology and id resolvers exposed to auxiliary vector containers. */
export interface VectorCorpusBinding {
  readonly documentCount: number
  readonly nextId: number
  readonly externalIds: readonly unknown[] | null
  readonly lookup: IdToShortIdLookup
}

/** Host interface implemented by {@link FrozenMiniSearch} instances. */
export interface VectorCorpusHost {
  [VECTOR_CORPUS_BINDING](): VectorCorpusBinding
}
