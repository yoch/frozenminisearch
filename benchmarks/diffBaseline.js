/**
 * Compare benchmark results against benchmarks/baselines/reference.json.
 *
 *   yarn benchmark:diff           → run suite now, compare to reference
 *   yarn benchmark:diff --latest  → compare latest.json to reference (no re-run)
 *
 * Exit code 1 if regressions exceed thresholds (for CI).
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectRunMetadata, parseRunsArg } from './benchmarkUtils.js'
import { runBenchmarkSuite } from './benchmarkSuite.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REFERENCE_PATH = join(__dirname, 'baselines', 'reference.json')
const LATEST_PATH = join(__dirname, 'baselines', 'latest.json')

const useLatest = process.argv.includes('--latest')
const strictSearch = process.argv.includes('--strict')
const runs = parseRunsArg()

/** Lower is better unless noted. */
const THRESHOLDS = {
  heapFrozenMb: { warnPct: 5, failPct: 10 },
  loadBinaryMs: { warnPct: 10, failPct: 20 },
  saveBinaryMs: { warnPct: 15, failPct: 30 },
  freezeMs: { warnPct: 20, failPct: 40 },
  frozenSearchP50: { warnPct: 20, failPct: 50 },
  heapFrozenSavingPct: { warnDrop: 5, failDrop: 10, higherIsBetter: true }
}

function loadJson (path) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Run: yarn benchmark:baseline:update`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function classifyRegression (metricKey, deltaPct, deltaPoints) {
  const t = THRESHOLDS[metricKey]
  if (!t) return 'ok'

  if (t.higherIsBetter) {
    if (deltaPoints <= -t.failDrop) return 'fail'
    if (deltaPoints <= -t.warnDrop) return 'warn'
    return 'ok'
  }

  if (deltaPct >= t.failPct) return 'fail'
  if (deltaPct >= t.warnPct) return 'warn'
  return 'ok'
}

function formatDelta (deltaPct, suffix = '%') {
  if (deltaPct == null) return '—'
  const sign = deltaPct > 0 ? '+' : ''
  return `${sign}${deltaPct.toFixed(1)}${suffix}`
}

function compareMetric (label, refVal, curVal, metricKey, higherIsBetter = false) {
  let deltaPct = null
  let deltaPoints = null
  if (refVal != null && curVal != null && refVal !== 0) {
    deltaPct = ((curVal - refVal) / refVal) * 100
  }
  if (higherIsBetter && refVal != null && curVal != null) {
    deltaPoints = curVal - refVal
  }
  const status = higherIsBetter
    ? classifyRegression(metricKey, null, deltaPoints)
    : classifyRegression(metricKey, deltaPct, null)

  const deltaStr = higherIsBetter ? formatDelta(deltaPoints, ' pts') : formatDelta(deltaPct)
  const icon = status === 'fail' ? 'FAIL' : status === 'warn' ? 'warn' : 'ok  '
  console.log(
    `  ${icon} ${label.padEnd(32)} ref=${String(refVal).padEnd(10)} cur=${String(curVal).padEnd(10)} Δ ${deltaStr}`
  )
  return status
}

function compareScenario (ref, cur) {
  console.log(`\n${'─'.repeat(72)}`)
  console.log(`${cur.name} (${cur.id})`)
  console.log('─'.repeat(72))

  let worst = 'ok'

  const bump = (s) => {
    if (s === 'fail') worst = 'fail'
    else if (s === 'warn' && worst !== 'fail') worst = 'warn'
  }

  bump(compareMetric('heap frozen (MB)', ref.heapMb.frozen, cur.heapMb.frozen, 'heapFrozenMb'))
  bump(compareMetric('heap saving vs mutable (%)', ref.heapMb.frozenVsMutableSavingPct, cur.heapMb.frozenVsMutableSavingPct, 'heapFrozenSavingPct', true))
  bump(compareMetric('loadBinary (ms)', ref.loadMs.binary, cur.loadMs.binary, 'loadBinaryMs'))
  bump(compareMetric('saveBinary (ms)', ref.indexing.saveBinaryMs, cur.indexing.saveBinaryMs, 'saveBinaryMs'))
  bump(compareMetric('freeze (ms)', ref.indexing.freezeMs, cur.indexing.freezeMs, 'freezeMs'))
  bump(compareMetric('disk binary (MB)', ref.diskMb.binary, cur.diskMb.binary, 'heapFrozenMb'))
  bump(compareMetric('postings typed (MB)', mb(ref.memoryBreakdown.postings.totalTypedBytes), mb(cur.memoryBreakdown.postings.totalTypedBytes), 'heapFrozenMb'))
  bump(compareMetric('radix est. (MB)', mb(ref.memoryBreakdown.radixTree.estimatedBytes), mb(cur.memoryBreakdown.radixTree.estimatedBytes), 'heapFrozenMb'))

  const refSearch = Object.fromEntries(ref.search.map((r) => [r.label, r]))
  for (const row of cur.search) {
    const prev = refSearch[row.label]
    if (!prev) continue
    const s = compareMetric(`search p50 ${row.label}`, prev.frozenP50, row.frozenP50, 'frozenSearchP50')
    if (strictSearch) bump(s)
    else if (s === 'warn') {
      console.log(`       (search timing informational only; use --strict to fail on search)`)
    }
  }

  return worst
}

function mb (bytes) {
  return Number((bytes / 1024 / 1024).toFixed(3))
}

function main () {
  const reference = loadJson(REFERENCE_PATH)

  let current
  if (useLatest) {
    current = loadJson(LATEST_PATH)
    console.log('Comparing latest.json → reference.json\n')
    if (runs > 1) {
      console.log('Note: --runs is ignored with --latest (no re-run).')
    }
  } else {
    console.log('Running benchmark suite and comparing to reference.json\n')
    if (!global.gc) {
      console.warn('Tip: use node --expose-gc for stable heap numbers.\n')
    }
    current = {
      ...collectRunMetadata(),
      runs,
      scenarios: runBenchmarkSuite(undefined, runs)
    }
  }

  console.log(`Reference: ${reference.capturedAt} @ ${reference.git?.commitShort}`)
  console.log(`Current:   ${current.capturedAt} @ ${current.git?.commitShort}${current.git?.dirty ? ' (dirty)' : ''}`)
  if (runs > 1 && !useLatest) {
    console.log(`Runs per scenario: ${runs} (median aggregation)`)
  }

  const curById = Object.fromEntries(current.scenarios.map((s) => [s.id, s]))
  let overall = 'ok'

  for (const refScenario of reference.scenarios) {
    const curScenario = curById[refScenario.id]
    if (!curScenario) {
      console.log(`\nMissing scenario in current run: ${refScenario.id}`)
      overall = 'fail'
      continue
    }
    const status = compareScenario(refScenario, curScenario)
    if (status === 'fail') overall = 'fail'
    else if (status === 'warn' && overall === 'ok') overall = 'warn'
  }

  console.log(`\n${'='.repeat(72)}`)
  if (overall === 'ok') {
    console.log('No significant regressions vs reference.')
  } else if (overall === 'warn') {
    console.log('Warnings: some metrics regressed within warn thresholds.')
  } else {
    console.log('FAIL: regressions exceed thresholds. Review before merging.')
  }
  console.log('='.repeat(72))
  console.log('\nThresholds (fail): heap frozen +10%; loadBinary +20%; heap saving −10 pts.')
  console.log('Search p50: warn only (noisy); add --strict to treat search regressions as failures.')
  console.log('Update reference after intentional wins: yarn benchmark:baseline:update\n')

  if (overall === 'fail') process.exit(1)
}

main()
