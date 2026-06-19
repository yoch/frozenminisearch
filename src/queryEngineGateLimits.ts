/**
 * Internal AND / AND_NOT gate thresholds (not exported from the public package entry).
 */

export type QueryEngineGateLimits = {
  maxAbsolute: number
  maxFraction: number
}

/** Oracle / bench overrides passed to `executeQueryWithRunOptions` (not on production `QueryEngineParams`). */
export type QueryEngineRunOptions = {
  disableGating?: boolean
  gateLimits?: QueryEngineGateLimits
  /** Bench/calibration override for posting-ratio gate (internal). */
  postingGatePolicy?: PostingGatePolicy
}

export type PostingGatePolicy = {
  minLength: number
  /** gate passes if gateSize <= postingListLength >>> ratioShift */
  ratioShift: number
}

export const DEFAULT_POSTING_GATE_MIN_LENGTH = 2048
export const DEFAULT_POSTING_GATE_RATIO_SHIFT = 2

export const DEFAULT_POSTING_GATE_POLICY: PostingGatePolicy = {
  minLength: DEFAULT_POSTING_GATE_MIN_LENGTH,
  ratioShift: DEFAULT_POSTING_GATE_RATIO_SHIFT,
}

export function passGateByPostingRatio(
  gateSize: number,
  postingListLength: number,
  policy: PostingGatePolicy = DEFAULT_POSTING_GATE_POLICY,
): boolean {
  if (postingListLength < policy.minLength) return false
  return gateSize <= (postingListLength >>> policy.ratioShift)
}

export function postingGateMaxRatio(policy: PostingGatePolicy): number {
  return 1 / (1 << policy.ratioShift)
}

export const DEFAULT_AND_GATE_LIMITS: QueryEngineGateLimits = {
  maxAbsolute: 5000,
  maxFraction: 0.1,
}

export function resolveGateMaxSize(
  documentCount: number,
  limits: QueryEngineGateLimits = DEFAULT_AND_GATE_LIMITS,
): number {
  return Math.min(
    limits.maxAbsolute,
    Math.max(100, Math.floor(documentCount * limits.maxFraction)),
  )
}

export function gateIsSelectiveEnough(
  gateSize: number,
  documentCount: number,
  limits: QueryEngineGateLimits = DEFAULT_AND_GATE_LIMITS,
  postingListLength?: number,
  postingGatePolicy: PostingGatePolicy = DEFAULT_POSTING_GATE_POLICY,
): boolean {
  if (gateSize === 0) return true
  if (gateSize <= resolveGateMaxSize(documentCount, limits)) return true
  if (
    postingListLength != null
    && postingListLength > 0
    && passGateByPostingRatio(gateSize, postingListLength, postingGatePolicy)
  ) {
    return true
  }
  return false
}
