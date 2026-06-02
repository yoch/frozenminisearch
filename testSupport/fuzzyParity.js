/** Shared fuzzy parity helpers (packed vs SearchableMap). */

export function sortedFuzzyTuples (entries) {
  return [...entries]
    .map(([term, value, distance]) => [term, value, distance])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[2] - b[2] || a[1] - b[1])
}

export function sortedMapFuzzy (results) {
  return [...results]
    .map(([term, [value, distance]]) => [term, value, distance])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[2] - b[2] || a[1] - b[1])
}
