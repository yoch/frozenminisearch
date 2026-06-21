/** Shared median helpers and bench timing constants. */

/** Warmup searches before timing (JIT + per-instance posting view cache on frozen indexes). */
export const DEFAULT_BENCH_WARMUP = 100

/** Default heap trial count for reference captures (~7; override with BENCH_HEAP_TRIALS). */
export const DEFAULT_HEAP_TRIALS = 7

/** Regression / dev heap trials. */
export const DEFAULT_HEAP_TRIALS_FAST = 3

export const DEFAULT_HEAP_GC_PASSES = 3

/** Reduced warm-up for very large corpora (>10k docs). */
export const HEAP_WARMUP_CAP = 20

export const HEAP_BENCH_PROTOCOL_VERSION = 3

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

/** Median absolute deviation from the sample median. */
export function madOf (values) {
  if (values.length === 0) return 0
  const med = median(values)
  return median(values.map((v) => Math.abs(v - med)))
}

export function madRound (values, digits = 3) {
  return Number(madOf(values).toFixed(digits))
}

/** MAD on byte samples, reported in megabytes. */
export function madMbRound (byteSamples, digits = 3) {
  return madRound(byteSamples.map((b) => b / 1024 / 1024), digits)
}
