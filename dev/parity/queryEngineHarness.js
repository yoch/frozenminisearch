/**
 * Test helpers (not published) — frozen query engine oracle.
 */
import FrozenMiniSearch from '../../src/FrozenMiniSearch'
import { readStoredFields } from '../../src/storedFieldsLayout'
import { finalizeRawSearchResults } from '../../src/scoring'
import { executeQueryWithRunOptions } from '../../src/queryEngine'

export function searchNaive(frozen, query, searchOptions = {}) {
  const priv = frozen
  const params = priv._queryEngineParams
  const raw = executeQueryWithRunOptions(query, searchOptions, params, { disableGating: true })
  return finalizeRawSearchResults(
    raw,
    query,
    searchOptions,
    priv._options.searchOptions,
    docId => priv._externalIds[docId],
    docId => readStoredFields(priv._storedFields, docId),
  )
}

export function searchWithRunOptions(frozen, query, searchOptions = {}, run) {
  const priv = frozen
  const params = priv._queryEngineParams
  const raw = executeQueryWithRunOptions(query, searchOptions, params, run)
  return finalizeRawSearchResults(
    raw,
    query,
    searchOptions,
    priv._options.searchOptions,
    docId => priv._externalIds[docId],
    docId => readStoredFields(priv._storedFields, docId),
  )
}
