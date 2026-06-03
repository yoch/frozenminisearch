/**
 * Helpers used only by volet3-cold-warm.mjs (not part of the routine benchmark suite).
 */
import FrozenMiniSearch from '../src/FrozenMiniSearch.ts'
import { resetFrozenFieldTermDataCache } from '../src/queryEngineHarness.ts'

export function benchSearchColdReset (
  index,
  query,
  searchOptions = {},
  iterations,
) {
  const times = []
  for (let i = 0; i < iterations; i++) {
    if (index instanceof FrozenMiniSearch) {
      resetFrozenFieldTermDataCache(index)
    }
    const t0 = performance.now()
    index.search(query, searchOptions)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
  }
}

export function benchSearchFreshInstance (
  createIndex,
  query,
  searchOptions = {},
  iterations = 5,
) {
  const times = []
  for (let i = 0; i < iterations; i++) {
    const index = createIndex()
    const t0 = performance.now()
    index.search(query, searchOptions)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
  }
}
