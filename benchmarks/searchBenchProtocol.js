/** Target wall-clock ms per timed sample when calibrating fixed search batches. */
export const SEARCH_BENCH_BATCH_TARGET_MS = 3

/** Max searches per timed window (calibration + runtime cap). */
export const SEARCH_BENCH_MAX_BATCH = 256

/** Below this probe p50 (ms), use {@link SEARCH_BENCH_ITERATIONS_FAST} at record time. */
export const SEARCH_BENCH_FAST_PROBE_MS = 0.1

/** Default timed iterations per query (see {@link SEARCH_BENCH_ITERATIONS_FAST}). */
export const SEARCH_BENCH_ITERATIONS = 20

/** Extra iterations for fast queries (probe p50 &lt; {@link SEARCH_BENCH_FAST_PROBE_MS}). */
export const SEARCH_BENCH_ITERATIONS_FAST = 50

/** Probe iterations when calibrating batch sizes (not used at record time). */
export const SEARCH_BENCH_CALIBRATE_PROBE_ITERS = 10

/**
 * Fixed batch size from a single-search probe median (calibration only).
 * @param {number} probeP50Ms
 * @param {{ targetMs?: number, maxBatch?: number }} [options]
 */
export function computeSearchBenchBatchFromProbe (
  probeP50Ms,
  { targetMs = SEARCH_BENCH_BATCH_TARGET_MS, maxBatch = SEARCH_BENCH_MAX_BATCH } = {},
) {
  if (probeP50Ms <= 0 || probeP50Ms >= targetMs) return 1
  return Math.min(maxBatch, Math.max(1, Math.ceil(targetMs / probeP50Ms)))
}
