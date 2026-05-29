/** Regression policy for tiny frozen heap measurements (noisy % deltas). */
export const HEAP_MB_FLOOR = 0.05
export const HEAP_ABS_FAIL_KB = 256
export const HEAP_ABS_WARN_KB = 128

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
