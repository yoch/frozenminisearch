/**
 * Fast validation for adaptive posting frequencies (u8/u16).
 * Runs only the scenarios that matter for this change (~1–3 min vs full suite).
 *
 *   pnpm benchmark:validate:freq-adaptive
 *   RUNS=1 SEARCH_ITERATIONS=10 BENCH_WARMUP=15 pnpm benchmark:validate:freq-adaptive
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScenario } from '../benchmarkSuite.js'
import { buildScenarioList } from '../benchmarkSuite.js'
import { applySearchBenchBatchesToScenarios } from '../loadSearchBenchBatches.js'
import {
  compareSearchMetric,
  compareTimingMetric,
  refBelowHeapFloor,
  HEAP_ABS_FAIL_KB,
  HEAP_ABS_WARN_KB,
  HEAP_MB_FLOOR,
} from '../regressionPolicy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REFERENCE_PATH = join(__dirname, '../baselines/reference.json')

const SCENARIO_IDS = [
  'divina-storeFields',
  'extreme-overflowFrequency',
  'extreme-giantVocabulary',
]

const runs = Number(process.env.RUNS) > 0 ? Math.floor(Number(process.env.RUNS)) : 1
const searchIterations = Number(process.env.SEARCH_ITERATIONS) > 0
  ? Math.floor(Number(process.env.SEARCH_ITERATIONS))
  : 10

function refById () {
  if (!existsSync(REFERENCE_PATH)) {
    console.error(`Missing ${REFERENCE_PATH}`)
    process.exit(1)
  }
  const ref = JSON.parse(readFileSync(REFERENCE_PATH, 'utf8'))
  return Object.fromEntries(ref.scenarios.map((s) => [s.id, s]))
}

function pickScenarios () {
  const all = applySearchBenchBatchesToScenarios(buildScenarioList())
  const byId = Object.fromEntries(all.map((s) => [s.id, s]))
  return SCENARIO_IDS.map((id) => {
    const s = byId[id]
    if (s == null) throw new Error(`scenario not found: ${id}`)
    return s
  })
}

function worstStatus (a, b) {
  if (a === 'fail' || b === 'fail') return 'fail'
  if (a === 'warn' || b === 'warn') return 'warn'
  return 'ok'
}

function compareScenario (ref, cur) {
  let status = 'ok'
  const bump = (st) => { status = worstStatus(status, st) }

  const heapRef = ref.heapMb?.frozen
  const heapCur = cur.heapMb?.frozen
  if (heapRef != null && heapCur != null) {
    if (refBelowHeapFloor(heapRef)) {
      const absDeltaKb = (heapCur - heapRef) * 1024
      const st = absDeltaKb > HEAP_ABS_FAIL_KB ? 'fail' : absDeltaKb > HEAP_ABS_WARN_KB ? 'warn' : 'ok'
      const icon = st === 'fail' ? 'FAIL' : st === 'warn' ? 'warn' : 'ok  '
      console.log(`    ${icon} heap frozen ref=${heapRef} cur=${heapCur} Δ +${absDeltaKb.toFixed(0)} KB (floor < ${HEAP_MB_FLOOR} MB)`)
      bump(st)
    } else if (heapCur > heapRef * 1.1) {
      console.log(`    FAIL heap frozen ref=${heapRef} cur=${heapCur}`)
      bump('fail')
    } else {
      console.log(`    ok   heap frozen ref=${heapRef} cur=${heapCur}`)
    }
  }

  // Single-run smoke: log structural/search timings for humans; do not fail (noisy vs 3-run reference).
  const logOnly = (st) => {
    if (st === 'fail') console.log('         (smoke: not gating on single-run timing)')
  }
  compareTimingMetric('freezeMs', ref.indexing?.freezeMs, cur.indexing?.freezeMs, 'freezeMs', logOnly, 11)
  compareTimingMetric('saveBinaryMs', ref.indexing?.saveBinaryMs, cur.indexing?.saveBinaryMs, 'saveBinaryMs', logOnly, 11)
  compareTimingMetric('loadBinaryMs', ref.loadMs?.binary, cur.loadMs?.binary, 'loadBinaryMs', logOnly, 11)

  const refSearch = ref.search ?? []
  for (const row of cur.search ?? []) {
    const refRow = refSearch.find((x) => x.label === row.label)
    if (refRow == null) continue
    compareSearchMetric(`search ${row.label} p50`, refRow.frozenP50, row.frozenP50, 24)
  }

  const refFreqs = ref.memoryBreakdown?.postings?.allFreqsBytes
  const curFreqs = cur.memoryBreakdown?.postings?.allFreqsBytes
  if (refFreqs != null && curFreqs != null) {
    if (cur.id === 'extreme-overflowFrequency') {
      if (curFreqs < refFreqs) {
        console.log('    FAIL allFreqsBytes (overflow expects u16 growth)')
        bump('fail')
      } else if (curFreqs > refFreqs * 1.05) {
        console.log(`    ok   allFreqsBytes overflow u16: ref=${refFreqs} cur=${curFreqs}`)
      } else {
        console.log(`    warn allFreqsBytes ref=${refFreqs} cur=${curFreqs}`)
        bump('warn')
      }
    } else if (curFreqs > refFreqs * 1.02) {
      console.log(`    FAIL allFreqsBytes ref=${refFreqs} cur=${curFreqs}`)
      bump('fail')
    } else {
      console.log(`    ok   allFreqsBytes ref=${refFreqs} cur=${curFreqs}`)
    }
  }

  const refDrift = ref.scoreDrift?.[0]
  const curDrift = cur.scoreDrift?.[0]
  if (curDrift != null) {
    const maxRel = curDrift.maxRelScoreDeltaPct ?? 0
    if (maxRel > 0.05) {
      console.log(`    FAIL scoreDrift maxRel=${maxRel}%`)
      bump('fail')
    } else {
      console.log(`    ok   scoreDrift maxRel=${maxRel}%`)
    }
    if (refDrift != null && refDrift.maxRelScoreDeltaPct > 0.1 && maxRel < 0.05) {
      console.log(`    note scoreDrift improved vs reference (${refDrift.maxRelScoreDeltaPct}% → ${maxRel}%)`)
    }
  }

  return status
}

function main () {
  if (!global.gc) {
    console.warn('Warning: use node --expose-gc for stable heap.\n')
  }

  const reference = refById()
  const scenarios = pickScenarios()
  console.log(`freq-adaptive validate: ${scenarios.length} scenarios, runs=${runs}, searchIterations=${searchIterations}\n`)

  let overall = 'ok'
  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]
    const t0 = performance.now()
    console.log(`[${i + 1}/${scenarios.length}] ${scenario.id} …`)
    const cur = runScenario(scenario)
    console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    const ref = reference[scenario.id]
    if (ref == null) {
      console.warn(`  no reference entry for ${scenario.id}`)
      continue
    }
    const st = compareScenario(ref, cur)
    overall = worstStatus(overall, st)
    console.log('')
  }

  if (overall === 'fail') {
    console.error('freq-adaptive validation FAILED')
    process.exit(1)
  }
  if (overall === 'warn') {
    console.warn('freq-adaptive validation passed with warnings')
  } else {
    console.log('freq-adaptive validation OK')
  }
}

main()
