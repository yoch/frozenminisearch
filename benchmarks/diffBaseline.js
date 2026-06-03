/**
 * Compare benchmark results against benchmarks/baselines/reference.json.
 *
 *   yarn benchmark:diff              → latest.json vs reference (no re-run)
 *   yarn benchmark:diff --run          → run suite, write latest.json, then diff
 *   yarn benchmark:diff --current=a.json --reference=b.json
 *
 * Exit code 1 if regressions exceed thresholds (for CI).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectRunMetadata,
  parseBenchmarkArgs,
  loadBenchmarkPayload,
  argValue,
  DEFAULT_BENCHMARK_RUNS,
  DEFAULT_SEARCH_ITERATIONS,
} from './benchmarkUtils.js'
import {
  STRUCTURAL_TIMING_THRESHOLDS,
  compareHeapFrozenMb,
  compareHeapSavingPct,
  compareSearchMetric,
  compareTimingMetric,
  SEARCH_MS_FLOOR,
} from './regressionPolicy.js'
import { runBenchmarkSuite } from './benchmarkSuite.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES_DIR = join(__dirname, 'baselines')
const REFERENCE_PATH = join(BASELINES_DIR, 'reference.json')
const LATEST_PATH = join(BASELINES_DIR, 'latest.json')

const argv = process.argv.slice(2)
const strictSearch = argv.includes('--strict')
const forceRun = argv.includes('--run')

const { runs, searchIterations } = parseBenchmarkArgs()

/** Lower is better unless noted. */
const THRESHOLDS = {
  heapFrozenMb: { warnPct: 5, failPct: 10 },
  ...STRUCTURAL_TIMING_THRESHOLDS,
  heapFrozenSavingPct: { warnDrop: 5, failDrop: 10, higherIsBetter: true },
}

function loadJson (path) {
  if (!existsSync(path)) {
    console.error(`Missing ${path}. Run: yarn benchmark:record`)
    process.exit(1)
  }
  return loadBenchmarkPayload(path)
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
    `  ${icon} ${label.padEnd(32)} ref=${String(refVal).padEnd(10)} cur=${String(curVal).padEnd(10)} Δ ${deltaStr}`,
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

  const skipHeapSaving = compareHeapFrozenMb(ref.heapMb.frozen, cur.heapMb.frozen, compareMetric, bump)
  compareHeapSavingPct(ref, cur, skipHeapSaving, compareMetric, bump)
  compareTimingMetric('loadBinary (ms)', ref.loadMs.binary, cur.loadMs.binary, 'loadBinaryMs', bump)
  compareTimingMetric('saveBinary (ms)', ref.indexing.saveBinaryMs, cur.indexing.saveBinaryMs, 'saveBinaryMs', bump)
  compareTimingMetric('freeze (ms)', ref.indexing.freezeMs, cur.indexing.freezeMs, 'freezeMs', bump)
  bump(compareMetric('disk binary (MB)', ref.diskMb.binary, cur.diskMb.binary, 'heapFrozenMb'))
  bump(compareMetric('postings typed (MB)', mb(ref.memoryBreakdown.postings.totalTypedBytes), mb(cur.memoryBreakdown.postings.totalTypedBytes), 'heapFrozenMb'))
  bump(compareMetric('radix est. (MB)', mb(ref.memoryBreakdown.radixTree.estimatedBytes), mb(cur.memoryBreakdown.radixTree.estimatedBytes), 'heapFrozenMb'))

  const refSearch = Object.fromEntries(ref.search.map((r) => [r.label, r]))
  for (const row of cur.search) {
    const prev = refSearch[row.label]
    if (!prev) continue
    const s = compareSearchMetric(`search p50 ${row.label}`, prev.frozenP50, row.frozenP50)
    if (strictSearch) {
      bump(s)
    } else if (s !== 'ok') {
      console.log('       (search timing informational only; use --strict to fail on search)')
    }
  }

  return worst
}

function mb (bytes) {
  return Number((bytes / 1024 / 1024).toFixed(3))
}

function main () {
  const referencePath = argValue('--reference', argv) ?? REFERENCE_PATH
  const currentPath = argValue('--current', argv) ?? LATEST_PATH
  const reference = loadJson(referencePath)

  let current
  if (forceRun) {
    console.log('Running benchmark suite → latest.json, then comparing to reference\n')
    if (!global.gc) {
      console.warn('Tip: use node --expose-gc for stable heap numbers.\n')
    }
    current = {
      ...collectRunMetadata(),
      runs,
      searchIterations,
      scenarios: runBenchmarkSuite(undefined, runs, searchIterations),
    }
    mkdirSync(BASELINES_DIR, { recursive: true })
    writeFileSync(LATEST_PATH, JSON.stringify(current, null, 2) + '\n')
    console.log(`Wrote ${LATEST_PATH}\n`)
  } else {
    console.log(`Comparing ${currentPath} → ${referencePath} (no re-run; use --run to measure again)\n`)
    if (runs !== DEFAULT_BENCHMARK_RUNS || searchIterations !== DEFAULT_SEARCH_ITERATIONS) {
      console.log('Note: --runs / --iterations apply only with --run.\n')
    }
    current = loadJson(currentPath)
  }

  console.log(`Reference: ${reference.capturedAt} @ ${reference.git?.commitShort}`)
  console.log(`Current:   ${current.capturedAt} @ ${current.git?.commitShort}${current.git?.dirty ? ' (dirty)' : ''}`)
  const curRuns = current.runs ?? 1
  const curIters = current.searchIterations ?? '(legacy)'
  if (forceRun) {
    console.log(`Measured:  ${runs} run(s)/scenario, ${searchIterations} search iterations`)
  } else {
    console.log(`Captured:  ${curRuns} run(s)/scenario, ${curIters} search iterations`)
  }

  const curById = Object.fromEntries(current.scenarios.map((s) => [s.id, s]))
  let overall = 'ok'

  for (const refScenario of reference.scenarios) {
    const curScenario = curById[refScenario.id]
    if (!curScenario) {
      console.log(`\nMissing scenario in current capture: ${refScenario.id}`)
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
  console.log(`Search p50: abs floor below ${SEARCH_MS_FLOOR} ms; informational unless --strict.`)
  console.log('Workflow: benchmark:record once → benchmark:diff (or diff other JSON via --current).\n')

  if (overall === 'fail') process.exit(1)
}

main()
