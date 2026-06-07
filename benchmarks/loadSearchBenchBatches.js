import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SEARCH_BENCH_BATCH_TARGET_MS,
  SEARCH_BENCH_MAX_BATCH,
  SEARCH_BENCH_CALIBRATE_PROBE_ITERS,
  SEARCH_BENCH_FAST_PROBE_MS,
  SEARCH_BENCH_ITERATIONS,
  SEARCH_BENCH_ITERATIONS_FAST,
} from './searchBenchProtocol.js'

const BATCHES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'searchBenchBatches.json')

let cached

export function searchBenchBatchKey (scenarioId, label) {
  return `${scenarioId}::${label}`
}

export function loadSearchBenchBatches () {
  if (cached) return cached
  if (!existsSync(BATCHES_PATH)) {
    throw new Error(
      `Missing ${BATCHES_PATH}. Run: yarn benchmark:calibrate-batches`,
    )
  }
  cached = JSON.parse(readFileSync(BATCHES_PATH, 'utf8'))
  return cached
}

export function getSearchBenchProtocol () {
  const file = loadSearchBenchBatches()
  return {
    protocolVersion: file.protocolVersion ?? 2,
    batchTargetMs: file.batchTargetMs ?? SEARCH_BENCH_BATCH_TARGET_MS,
    maxBatch: file.maxBatch ?? SEARCH_BENCH_MAX_BATCH,
    calibrateProbeIterations: file.calibrateProbeIterations ?? SEARCH_BENCH_CALIBRATE_PROBE_ITERS,
    fastProbeMs: SEARCH_BENCH_FAST_PROBE_MS,
    defaultIterations: SEARCH_BENCH_ITERATIONS,
    fastIterations: SEARCH_BENCH_ITERATIONS_FAST,
    timing: 'hrtime-paired',
    batchMode: 'fixed-per-query',
  }
}

export function getSearchBenchBatchEntry (scenarioId, label) {
  const file = loadSearchBenchBatches()
  const key = searchBenchBatchKey(scenarioId, label)
  const entry = file.entries?.[key]
  if (!entry?.batchSize) {
    throw new Error(
      `No fixed batch for ${key} in searchBenchBatches.json. Run: yarn benchmark:calibrate-batches`,
    )
  }
  return entry
}

/** Attach `benchBatch` to every query; validate the table covers the suite. */
export function applySearchBenchBatchesToScenarios (scenarios) {
  const file = loadSearchBenchBatches()
  const entries = file.entries ?? {}
  const used = new Set()

  const enriched = scenarios.map((scenario) => {
    const queries = scenario.queries.map((q) => {
      const key = searchBenchBatchKey(scenario.id, q.label)
      const entry = entries[key]
      if (!entry?.batchSize) {
        throw new Error(
          `Missing batch entry ${key}. Run: yarn benchmark:calibrate-batches`,
        )
      }
      used.add(key)
      return { ...q, benchBatch: entry.batchSize }
    })
    return { ...scenario, queries }
  })

  for (const key of Object.keys(entries)) {
    if (!used.has(key)) {
      console.warn(`searchBenchBatches.json: unused entry ${key}`)
    }
  }

  return enriched
}

export { BATCHES_PATH, SEARCH_BENCH_BATCH_TARGET_MS, SEARCH_BENCH_MAX_BATCH, SEARCH_BENCH_CALIBRATE_PROBE_ITERS }
