/**
 * Test and benchmark helpers (not part of the public package API).
 */
import MiniSearch from './MiniSearch'
import FrozenMiniSearch from './FrozenMiniSearch'
import { finalizeRawSearchResults, type RawResult } from './scoring'
import { executeQueryWithRunOptions, type QueryEngineParams } from './queryEngine'
import type { QueryEngineRunOptions } from './queryEngineGateLimits'
import type { Query, SearchOptions, SearchOptionsWithDefaults, SearchResult } from './searchTypes'

export type { QueryEngineRunOptions } from './queryEngineGateLimits'

type MutableSearchPriv = {
  _options: { searchOptions: SearchOptionsWithDefaults }
  _documentIds: Map<number, unknown>
  _storedFields: Map<number, Record<string, unknown> | undefined>
}

type FrozenSearchPriv = {
  _options: { searchOptions: SearchOptionsWithDefaults }
  _externalIds: unknown[]
  _storedFields: (Record<string, unknown> | undefined)[]
}

function queryEngineParamsFrom(engine: MiniSearch | FrozenMiniSearch): QueryEngineParams {
  if (engine instanceof FrozenMiniSearch) {
    return (engine as unknown as { _queryEngineParams: QueryEngineParams })._queryEngineParams
  }
  return (engine as unknown as { queryEngineParams(): QueryEngineParams }).queryEngineParams()
}

function finalizeEngineSearch(
  engine: MiniSearch | FrozenMiniSearch,
  rawResults: RawResult,
  query: Query,
  searchOptions: SearchOptions,
): SearchResult[] {
  if (engine instanceof FrozenMiniSearch) {
    const frozen = engine as unknown as FrozenSearchPriv
    return finalizeRawSearchResults(
      rawResults,
      query,
      searchOptions,
      frozen._options.searchOptions,
      FrozenMiniSearch.wildcard,
      docId => frozen._externalIds[docId],
      docId => frozen._storedFields[docId],
    )
  }
  const mutable = engine as unknown as MutableSearchPriv
  return finalizeRawSearchResults(
    rawResults,
    query,
    searchOptions,
    mutable._options.searchOptions,
    MiniSearch.wildcard,
    docId => mutable._documentIds.get(docId),
    docId => mutable._storedFields.get(docId),
  )
}

export function searchWithRunOptions(
  engine: MiniSearch | FrozenMiniSearch,
  query: Query,
  searchOptions: SearchOptions = {},
  run?: QueryEngineRunOptions,
): SearchResult[] {
  const raw = executeQueryWithRunOptions(query, searchOptions, queryEngineParamsFrom(engine), run)
  return finalizeEngineSearch(engine, raw, query, searchOptions)
}

/** Oracle path: score-then-combine without AND / AND_NOT branch gating. */
export function searchNaive(
  engine: MiniSearch | FrozenMiniSearch,
  query: Query,
  searchOptions: SearchOptions = {},
): SearchResult[] {
  return searchWithRunOptions(engine, query, searchOptions, { disableGating: true })
}
