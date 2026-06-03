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
): boolean {
  if (gateSize === 0) return true
  return gateSize <= resolveGateMaxSize(documentCount, limits)
}
