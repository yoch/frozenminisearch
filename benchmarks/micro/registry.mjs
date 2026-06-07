/** Micro-benchmark suites (Benchmark.js ops/sec on the Divina Commedia corpus). */
import exactSearch from '../exactSearch.js'
import prefixSearch from '../prefixSearch.js'
import fuzzySearch from '../fuzzySearch.js'
import combinedSearch from '../combinedSearch.js'
import ranking from '../ranking.js'
import searchFiltering from '../searchFiltering.js'
import autoSuggestion from '../autoSuggestion.js'

export const MICRO_SUITES = [
  { id: 'exact', suite: exactSearch },
  { id: 'prefix', suite: prefixSearch },
  { id: 'fuzzy', suite: fuzzySearch },
  { id: 'combined', suite: combinedSearch },
  { id: 'ranking', suite: ranking },
  { id: 'filter', suite: searchFiltering },
  { id: 'autosuggest', suite: autoSuggestion },
]

export function resolveMicroSuites(onlyIds) {
  if (!onlyIds || onlyIds.length === 0) return MICRO_SUITES
  const want = new Set(onlyIds)
  const picked = MICRO_SUITES.filter(entry => want.has(entry.id))
  const unknown = [...want].filter(id => !picked.some(e => e.id === id))
  if (unknown.length > 0) {
    throw new Error(`Unknown micro suite(s): ${unknown.join(', ')}. Use --list.`)
  }
  return picked
}
