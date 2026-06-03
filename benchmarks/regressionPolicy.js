/** Regression policy for tiny frozen heap measurements (noisy % deltas). */
export const HEAP_MB_FLOOR = 0.05
export const HEAP_ABS_FAIL_KB = 256
export const HEAP_ABS_WARN_KB = 128

/**
 * Structural timing thresholds (shared by benchmark:diff and targeted-failures).
 * Lower is better unless noted.
 */
export const STRUCTURAL_TIMING_THRESHOLDS = {
  freezeMs: { warnPct: 20, failPct: 40 },
  saveBinaryMs: { warnPct: 15, failPct: 30 },
  loadBinaryMs: { warnPct: 10, failPct: 20 },
}

/** Below this baseline (ms), use absolute ms and a % cap (both must pass). */
export const TIMING_MS_FLOOR = 10
export const TIMING_ABS_FAIL_MS = 5
export const TIMING_ABS_WARN_MS = 2
/** Extra % guard when baseline is tiny but non-zero (e.g. 3 ms → 5 ms). */
export const TIMING_FLOOR_FAIL_PCT = 35
export const TIMING_FLOOR_WARN_PCT = 20

/** Search p50 floor: below this, % deltas are unreliable (clock + JIT noise). */
export const SEARCH_MS_FLOOR = 0.1
export const SEARCH_ABS_FAIL_MS = 0.06
export const SEARCH_ABS_WARN_MS = 0.03
/** Above floor, search p50 uses these % thresholds (lower is better). */
export const SEARCH_PCT_FAIL = 50
export const SEARCH_PCT_WARN = 20

export function refBelowTimingFloor (baseMs) {
  return baseMs != null && baseMs < TIMING_MS_FLOOR
}

export function refBelowSearchFloor (baseMs) {
  return baseMs != null && baseMs < SEARCH_MS_FLOOR
}

export function classifyPctRegression (metricKey, deltaPct) {
  const t = STRUCTURAL_TIMING_THRESHOLDS[metricKey]
  if (t == null || deltaPct == null) return 'ok'
  if (deltaPct >= t.failPct) return 'fail'
  if (deltaPct >= t.warnPct) return 'warn'
  return 'ok'
}

function classifyTimingFloorRegression (baseMs, curMs) {
  const absDelta = curMs - baseMs
  let status = 'ok'
  if (absDelta > TIMING_ABS_FAIL_MS) status = 'fail'
  else if (absDelta > TIMING_ABS_WARN_MS) status = 'warn'

  if (baseMs >= 0.5) {
    const deltaPct = (absDelta / baseMs) * 100
    if (deltaPct >= TIMING_FLOOR_FAIL_PCT) status = 'fail'
    else if (deltaPct >= TIMING_FLOOR_WARN_PCT && status === 'ok') status = 'warn'
  }
  return status
}

/**
 * Classify timing regression; uses floor rules when baseline &lt; {@link TIMING_MS_FLOOR}.
 * Only slower regressions (cur &gt; base) can warn/fail.
 */
export function classifyTimingRegression (baseMs, curMs, metricKey) {
  if (baseMs == null || curMs == null) return 'ok'
  if (curMs <= baseMs) return 'ok'

  if (refBelowTimingFloor(baseMs)) {
    return classifyTimingFloorRegression(baseMs, curMs)
  }

  const deltaPct = ((curMs - baseMs) / baseMs) * 100
  return classifyPctRegression(metricKey, deltaPct)
}

export function formatTimingDelta (baseMs, curMs) {
  if (baseMs == null || curMs == null) return '—'
  if (refBelowTimingFloor(baseMs)) {
    const sign = curMs >= baseMs ? '+' : ''
    const abs = `${sign}${(curMs - baseMs).toFixed(2)} ms`
    if (baseMs >= 0.5) {
      const pct = ((curMs - baseMs) / baseMs) * 100
      const pctSign = pct > 0 ? '+' : ''
      return `${abs} / ${pctSign}${pct.toFixed(1)}%`
    }
    return abs
  }
  if (baseMs === 0) return '—'
  const deltaPct = ((curMs - baseMs) / baseMs) * 100
  const sign = deltaPct > 0 ? '+' : ''
  return `${sign}${deltaPct.toFixed(1)}%`
}

/**
 * Print one timing comparison row and return status (ok | warn | fail).
 */
export function compareTimingMetric (label, baseMs, curMs, metricKey, bump, pad = 32) {
  const status = classifyTimingRegression(baseMs, curMs, metricKey)
  bump(status)
  const icon = status === 'fail' ? 'FAIL' : status === 'warn' ? 'warn' : 'ok  '
  const deltaStr = formatTimingDelta(baseMs, curMs)
  const floorNote = refBelowTimingFloor(baseMs) ? ` (floor; base < ${TIMING_MS_FLOOR} ms)` : ''
  console.log(
    `  ${icon} ${label.padEnd(pad)} base=${String(baseMs).padEnd(10)} cur=${String(curMs).padEnd(10)} Δ ${deltaStr}${floorNote}`,
  )
  return status
}

function classifySearchFloorRegression (baseMs, curMs) {
  const absDelta = curMs - baseMs
  if (absDelta > SEARCH_ABS_FAIL_MS) return 'fail'
  if (absDelta > SEARCH_ABS_WARN_MS) return 'warn'
  return 'ok'
}

/**
 * Classify frozen search p50 regression; uses floor rules when baseline &lt; {@link SEARCH_MS_FLOOR}.
 * Only slower regressions (cur &gt; base) can warn/fail.
 */
export function classifySearchRegression (baseMs, curMs) {
  if (baseMs == null || curMs == null) return 'ok'
  if (curMs <= baseMs) return 'ok'

  if (refBelowSearchFloor(baseMs)) {
    return classifySearchFloorRegression(baseMs, curMs)
  }

  const deltaPct = ((curMs - baseMs) / baseMs) * 100
  if (deltaPct >= SEARCH_PCT_FAIL) return 'fail'
  if (deltaPct >= SEARCH_PCT_WARN) return 'warn'
  return 'ok'
}

export function formatSearchDelta (baseMs, curMs) {
  if (baseMs == null || curMs == null) return '—'
  if (refBelowSearchFloor(baseMs)) {
    const sign = curMs >= baseMs ? '+' : ''
    const abs = `${sign}${(curMs - baseMs).toFixed(4)} ms`
    if (baseMs >= 0.01) {
      const pct = ((curMs - baseMs) / baseMs) * 100
      const pctSign = pct > 0 ? '+' : ''
      return `${abs} / ${pctSign}${pct.toFixed(1)}%`
    }
    return abs
  }
  if (baseMs === 0) return '—'
  const deltaPct = ((curMs - baseMs) / baseMs) * 100
  const sign = deltaPct > 0 ? '+' : ''
  return `${sign}${deltaPct.toFixed(1)}%`
}

/**
 * Print one frozen search p50 comparison row and return status (ok | warn | fail).
 */
export function compareSearchMetric (label, baseMs, curMs, pad = 32) {
  const status = classifySearchRegression(baseMs, curMs)
  const icon = status === 'fail' ? 'FAIL' : status === 'warn' ? 'warn' : 'ok  '
  const deltaStr = formatSearchDelta(baseMs, curMs)
  const floorNote = refBelowSearchFloor(baseMs) ? ` (floor; base < ${SEARCH_MS_FLOOR} ms)` : ''
  console.log(
    `  ${icon} ${label.padEnd(pad)} ref=${String(baseMs).padEnd(10)} cur=${String(curMs).padEnd(10)} Δ ${deltaStr}${floorNote}`,
  )
  return status
}

export function refBelowHeapFloor (heapRefMb) {
  return heapRefMb != null && heapRefMb < HEAP_MB_FLOOR
}

/**
 * Compare frozen heap MB; uses absolute KB deltas when reference is below {@link HEAP_MB_FLOOR}.
 * @returns whether reference was below the floor (skip saving-% comparison when true)
 */
export function compareHeapFrozenMb (heapRef, heapCur, compareMetric, bump) {
  const belowFloor = refBelowHeapFloor(heapRef)
  if (heapRef != null && heapCur != null && belowFloor) {
    const absDeltaKb = (heapCur - heapRef) * 1024
    const icon = absDeltaKb > HEAP_ABS_FAIL_KB ? 'FAIL' : absDeltaKb > HEAP_ABS_WARN_KB ? 'warn' : 'ok  '
    console.log(
      `  ${icon} heap frozen (MB)                 ref=${String(heapRef).padEnd(10)} cur=${String(heapCur).padEnd(10)} Δ +${absDeltaKb.toFixed(0)} KB (floor; ref < ${HEAP_MB_FLOOR} MB)`,
    )
    if (absDeltaKb > HEAP_ABS_FAIL_KB) bump('fail')
    else if (absDeltaKb > HEAP_ABS_WARN_KB) bump('warn')
    return true
  }
  bump(compareMetric('heap frozen (MB)', heapRef, heapCur, 'heapFrozenMb'))
  return belowFloor
}

export function compareHeapSavingPct (ref, cur, skip, compareMetric, bump) {
  if (skip) {
    console.log(
      `  ok   heap saving vs mutable (%)       ref=${ref.heapMb.frozenVsMutableSavingPct}       cur=${cur.heapMb.frozenVsMutableSavingPct}       (skipped; ref heap below floor)`,
    )
    return
  }
  bump(compareMetric(
    'heap saving vs mutable (%)',
    ref.heapMb.frozenVsMutableSavingPct,
    cur.heapMb.frozenVsMutableSavingPct,
    'heapFrozenSavingPct',
    true,
  ))
}
