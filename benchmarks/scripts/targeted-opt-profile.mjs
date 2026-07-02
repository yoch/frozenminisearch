#!/usr/bin/env node
/**
 * Targeted optimization profile for before/after experiments.
 *
 * Keeps the regular benchmark machinery, but restricts work to a chosen set of
 * scenarios and writes JSON outside the tracked baselines by default.
 *
 *   NODE_OPTIONS='--expose-gc' pnpm exec tsx benchmarks/scripts/targeted-opt-profile.mjs \
 *     --out=/tmp/minisearch-opt-baseline/targeted-profile.json \
 *     --surfaces=search,search-levels,build,load
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildBenchmarkScenarios, runScenario } from '../benchmarkSuite.js'
import { runHeapSuite, mergeHeapIntoScenarios } from '../framework/runHeapSuite.mjs'
import { collectRunMetadata } from '../benchmarkUtils.js'

const DEFAULT_SCENARIOS = [
  'extreme-giantVocabulary',
  'extreme-manyFields',
  'sparseFields-50kTerms-20Fields',
  'divina-indexOnly',
  'divina-storeFields',
]

function argValue(name) {
  const flag = `--${name}`
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === flag) return process.argv[i + 1]
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
  }
  return undefined
}

function listArg(name, fallback) {
  const raw = argValue(name)
  if (raw == null || raw.trim() === '') return fallback
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

function intArg(name, fallback) {
  const raw = argValue(name)
  const value = raw == null ? NaN : Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function scenarioMap() {
  return new Map(buildBenchmarkScenarios().map(s => [s.id, s]))
}

function pickScenarios(ids) {
  const byId = scenarioMap()
  return ids.map(id => {
    const scenario = byId.get(id)
    if (scenario == null) throw new Error(`Unknown scenario: ${id}`)
    return scenario
  })
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function aggregateRuns(results) {
  if (results.length === 1) return results[0]
  const first = results[0]
  const out = { ...first }

  if (first.indexing != null) {
    out.indexing = {}
    for (const key of Object.keys(first.indexing)) {
      const values = results.map(r => r.indexing?.[key]).filter(v => typeof v === 'number')
      if (values.length > 0) out.indexing[key] = Number(median(values).toFixed(2))
    }
    if (first.indexing.binaryMagic != null) out.indexing.binaryMagic = first.indexing.binaryMagic
  }

  if (first.loadMs != null) {
    out.loadMs = {}
    for (const key of Object.keys(first.loadMs)) {
      const values = results.map(r => r.loadMs?.[key]).filter(v => typeof v === 'number')
      if (values.length > 0) out.loadMs[key] = Number(median(values).toFixed(2))
    }
  }

  if (first.search != null) {
    out.search = first.search.map((row, i) => {
      const merged = { ...row }
      for (const key of ['mutableP50', 'mutableP95', 'frozenP50', 'frozenP95', 'pairedRatioP50', 'frozenP50VsMutablePct']) {
        const values = results.map(r => r.search?.[i]?.[key]).filter(v => typeof v === 'number')
        if (values.length > 0) merged[key] = Number(median(values).toFixed(4))
      }
      return merged
    })
  }

  if (first.searchLevels != null) {
    out.searchLevels = {}
    for (const label of Object.keys(first.searchLevels)) {
      out.searchLevels[label] = first.searchLevels[label]
      const l1 = results.map(r => r.searchLevels?.[label]?.L1?.frozenP50).filter(v => typeof v === 'number')
      if (l1.length > 0) {
        out.searchLevels[label] = {
          ...out.searchLevels[label],
          L1: {
            ...out.searchLevels[label].L1,
            frozenP50: Number(median(l1).toFixed(4)),
          },
        }
      }
    }
  }

  out.profileRuns = results.length
  return out
}

const out = argValue('out') ?? '/tmp/minisearch-opt-profile.json'
const scenarioIds = listArg('scenarios', DEFAULT_SCENARIOS)
const surfaces = listArg('surfaces', ['search', 'search-levels', 'build', 'load'])
const runs = intArg('runs', 1)
const heap = process.argv.includes('--heap') || surfaces.includes('memory')
const cpuSurfaces = surfaces.filter(s => s !== 'memory' && s !== 'breakdown')
const scenarios = pickScenarios(scenarioIds)

const payload = {
  ...collectRunMetadata(),
  profileKind: 'targeted-opt-profile',
  runs,
  scenarioIds,
  surfaces,
  scenarios: [],
}

for (const scenario of scenarios) {
  const scenarioRuns = []
  for (let i = 0; i < runs; i++) {
    scenarioRuns.push(runScenario(scenario, { surfaces: cpuSurfaces }))
  }
  payload.scenarios.push(aggregateRuns(scenarioRuns))
}

if (heap) {
  const heapSuite = runHeapSuite({
    scenarioIds,
    paths: ['mutable-addAll', 'frozen-fromDocuments'],
  })
  payload.heapBenchProtocol = heapSuite.heapBenchProtocol
  payload.scenarios = mergeHeapIntoScenarios(payload.scenarios, heapSuite)
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(payload, null, 2) + '\n')
console.log(`Wrote ${out}`)
