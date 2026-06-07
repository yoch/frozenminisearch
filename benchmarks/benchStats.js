/** Shared median helpers and bench timing constants. */

/** Warmup searches before timing (JIT + per-instance posting view cache on frozen indexes). */
export const DEFAULT_BENCH_WARMUP = 100

/** Median of numeric samples; 0 when empty (timing aggregates). */
export function median (values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

export function medianRound (values, digits) {
  return Number(median(values).toFixed(digits))
}
