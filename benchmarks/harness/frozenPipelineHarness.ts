/**
 * Benchmark-only helpers (not published) — decompose FrozenMiniSearch search/suggest pipeline.
 */
import type FrozenMiniSearchCore from '../../src/FrozenMiniSearchCore'
import { executeQuery } from '../../src/queryEngine'
import type { QueryEngineParams } from '../../src/queryEngine'
import { finalizeRawSearchResults, type RawResult } from '../../src/scoring'
import type { OptionsWithDefaults } from '../../src/frozenTypes'
import type { StoredFieldsLayout } from '../../src/storedFieldsLayout'
import type { Query, SearchOptions } from '../../src/searchTypes'

interface FrozenBenchView<T = unknown> {
  _queryEngineParams: QueryEngineParams
  _options: OptionsWithDefaults<T>
  _externalIds: unknown[]
  _storedFields: StoredFieldsLayout
}

function asBenchView<T>(frozen: FrozenMiniSearchCore<T>): FrozenBenchView<T> {
  return frozen as unknown as FrozenBenchView<T>
}

export function executeRaw<T>(
  frozen: FrozenMiniSearchCore<T>,
  query: Query,
  searchOptions: SearchOptions = {},
): RawResult {
  const view = asBenchView(frozen)
  return executeQuery(query, searchOptions, view._queryEngineParams)
}

export function finalizeRaw<T>(
  frozen: FrozenMiniSearchCore<T>,
  raw: RawResult,
  query: Query,
  searchOptions: SearchOptions = {},
) {
  const view = asBenchView(frozen)
  return finalizeRawSearchResults(
    raw,
    query,
    searchOptions,
    view._options.searchOptions,
    docId => view._externalIds[docId],
    undefined,
    view._storedFields,
  )
}

export function mergedAutoSuggestOptions<T>(
  frozen: FrozenMiniSearchCore<T>,
  autoSuggestOptions: SearchOptions = {},
): SearchOptions {
  const view = asBenchView(frozen)
  return { ...view._options.autoSuggestOptions, ...autoSuggestOptions }
}
