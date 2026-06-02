/** Shared fuzzy probe cases for packed radix CPU benches. */

export const FUZZY_BENCH_DISTANCES = [1, 2]

export function fuzzyCasesFromProbe (fuzzyQuery) {
  return FUZZY_BENCH_DISTANCES.map((maxDistance) => ({
    maxDistance,
    query: fuzzyQuery,
    label: `fuzzy("${fuzzyQuery}",${maxDistance})`,
  }))
}

/** Align with benchmarks/fuzzySearch.js + benchmarkSuite fuzzy scenario. */
export const DIVINA_FUZZY_CASES = [
  { query: 'virtute', maxDistance: 1 },
  { query: 'virtu', maxDistance: 2 },
  { query: 'virtu', maxDistance: 3 },
  { query: 'virtute', maxDistance: 4 },
  { query: 'infern', maxDistance: 1 },
]
