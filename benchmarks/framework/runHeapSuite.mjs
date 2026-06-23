import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScenarioList } from '../scenarioRegistry.mjs'
import {
  argValue,
  defaultHeapGcPasses,
  defaultHeapTrials,
} from '../benchmarkUtils.js'
import {
  HEAP_BENCH_PROTOCOL_VERSION,
} from '../benchStats.js'
import { parseHeapPaths, parseHeapScenarioIds } from './heapScenarios.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCENARIO_RUNNER = join(__dirname, 'heapScenarioRunner.mjs')

function assertKnownHeapScenarioIds (scenarioIds, known) {
  const unknown = scenarioIds.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new Error(`Unknown heap scenario(s): ${unknown.join(', ')}`)
  }
}

function spawnHeapScenario (scenarioId, { reference, paths, trials, gcPasses } = {}) {
  const args = [
    '--expose-gc',
    '--no-warnings',
    SCENARIO_RUNNER,
    scenarioId,
    `--scenario=${scenarioId}`,
  ]
  if (reference) args.push('--reference')
  if (paths?.length) args.push(`--heap-paths=${paths.join(',')}`)
  if (trials != null) args.push(`--heap-trials=${trials}`)
  if (gcPasses != null) args.push(`--heap-gc-passes=${gcPasses}`)

  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  if (r.status !== 0) {
    throw new Error(
      `heap scenario ${scenarioId} failed (exit ${r.status}): ${r.stderr || r.stdout}`,
    )
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

/**
 * Run isolated heap benchmarks for configured scenarios.
 * @param {object} [opts]
 * @returns {Record<string, object>}
 */
export function runHeapSuite (opts = {}) {
  const reference = opts.reference ?? process.argv.includes('--reference')
  const scenarioIds = opts.scenarioIds ?? parseHeapScenarioIds()
  const paths = opts.paths ?? parseHeapPaths()
  const trials = opts.trials ?? defaultHeapTrials({ reference })
  const gcPasses = opts.gcPasses ?? defaultHeapGcPasses()
  const allScenarios = buildScenarioList()
  const known = new Set(allScenarios.map((s) => s.id))
  assertKnownHeapScenarioIds(scenarioIds, known)

  const allowlist = new Set(scenarioIds)
  const skipped = allScenarios
    .filter((s) => !allowlist.has(s.id))
    .map((s) => ({ scenarioId: s.id, reason: 'not-in-allowlist' }))

  const results = {}

  for (const id of scenarioIds) {
    const t0 = performance.now()
    console.log(`[heap] ${id} (${trials} trials × ${paths.length} paths) …`)
    results[id] = spawnHeapScenario(id, { reference, paths, trials, gcPasses })
    console.log(
      `[heap] ${id} done in ${((performance.now() - t0) / 1000).toFixed(1)}s `
      + `(frozen total ${results[id].heapMb.frozenTotalResident} MB, ${results[id].heapMb.frozenVsMutableSavingPct}% vs mutable)`,
    )
  }

  return {
    results,
    skipped,
    heapBenchProtocol: {
      version: HEAP_BENCH_PROTOCOL_VERSION,
      trials,
      gcPasses,
      isolated: 'per-scenario',
      inProcessTrials: true,
      scenarioAllowlist: scenarioIds,
      paths,
    },
  }
}

export function mergeHeapIntoScenarios (cpuScenarios, heapSuiteResult) {
  const { results, skipped } = heapSuiteResult
  const skipMap = new Map(skipped.map((s) => [s.scenarioId, s.reason]))

  return cpuScenarios.map((scenario) => {
    const heap = results[scenario.id]
    if (heap) {
      return {
        ...scenario,
        heapMb: heap.heapMb,
        heapSkipped: null,
        heapStability: heap.heapStability,
        memoryMb: heap.memoryMb,
        memoryBreakdown: heap.memoryBreakdown,
        summary: {
          ...scenario.summary,
          heapFrozenVsMutableSavingPct: heap.heapMb.frozenVsMutableSavingPct,
        },
      }
    }
    if (skipMap.has(scenario.id)) {
      return {
        ...scenario,
        heapSkipped: skipMap.get(scenario.id),
      }
    }
    return scenario
  })
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const reference = process.argv.includes('--reference')
  const t0 = performance.now()
  const suite = runHeapSuite({ reference })
  const elapsedSec = ((performance.now() - t0) / 1000).toFixed(1)
  const out = argValue('--out')
  const payload = {
    capturedAt: new Date().toISOString(),
    elapsedSec: Number(elapsedSec),
    heapBenchProtocol: suite.heapBenchProtocol,
    skipped: suite.skipped,
    results: suite.results,
  }
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(payload, null, 2) + '\n')
    console.log(`Wrote ${out} (${elapsedSec}s)`)
  } else {
    console.log(JSON.stringify(payload, null, 2))
  }
}
