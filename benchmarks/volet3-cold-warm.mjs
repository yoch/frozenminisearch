/**
 * Volet 3 cold vs warm frozen search capture.
 * Run: npm run build && node --expose-gc benchmarks/volet3-cold-warm.mjs
 *
 * Compare output to benchmarks/baselines/reference.json (8.3.3),
 * volet3-baseline.json, volet3-no-cache.json.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchSearch, pctDeltaRound } from './benchmarkUtils.js'
import {
  benchSearchColdReset,
  benchSearchFreshInstance,
} from './volet3-benchHelpers.js'
import MiniSearch from '../dist/es/index.js'
import { loadDivinaLines } from './loadDivinaLines.js'
import { giantVocabulary } from './benchmarkScenarios.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES = join(__dirname, 'baselines')
const ITERS = Number(process.env.SEARCH_ITERATIONS) || 30

const divina = loadDivinaLines()
const divinaOpts = { fields: ['txt'], storeFields: ['txt'] }
const giant = giantVocabulary(50000)
const giantOpts = { fields: ['txt'], storeFields: [] }

const scenarios = [
  {
    label: 'divina-storeFields',
    buildFrozen () {
      const ms = new MiniSearch(divinaOpts)
      ms.addAll(divina)
      return ms.freeze()
    },
    search: [
      { label: 'exact', query: 'inferno', opts: {} },
      { label: 'prefix', query: 'infe', opts: { prefix: true } },
      { label: 'fuzzy', query: 'infern', opts: { fuzzy: 0.2 } },
      { label: 'AND+prefix', query: 'infe para', opts: { combineWith: 'AND', prefix: true } },
      { label: 'AND_NOT', query: 'inferno paradiso', opts: { combineWith: 'AND_NOT' } },
    ],
  },
  {
    label: 'giantVocabulary-50k',
    buildFrozen () {
      const ms = new MiniSearch(giantOpts)
      ms.addAll(giant)
      return ms.freeze()
    },
    search: [
      { label: 'exact', query: 'unique1', opts: {} },
      { label: 'prefix', query: 'unique', opts: { prefix: true } },
      { label: 'AND+prefix', query: 'unique1 common', opts: { combineWith: 'AND', prefix: true } },
      { label: 'AND_NOT', query: 'unique1 common', opts: { combineWith: 'AND_NOT' } },
    ],
  },
  {
    label: 'giantVocabulary-50k-ref-queries',
    note: 'Same queries as benchmarks/baselines/reference.json extreme-giantVocabulary',
    buildFrozen () {
      const ms = new MiniSearch(giantOpts)
      ms.addAll(giant)
      return ms.freeze()
    },
    search: [
      { label: 'exact', query: 'unique12345', opts: {} },
      { label: 'prefix', query: 'unique1', opts: { prefix: true } },
    ],
  },
]

/**
 * Fresh-instance cold is build-dominated; only run it on the smaller corpus.
 * NOTE: coldReset reallocates the full `new Array(termCount)` posting-view cache each
 * iteration, so coldReset on tiny single-term queries (e.g. giant `exact`) overstates the
 * real per-request cost. Treat coldReset as an upper bound, warm as the serving steady state.
 */
const FRESH_INSTANCE_ITERS = 5

function runScenario (scenario) {
  const isDivina = scenario.label.startsWith('divina')
  const documentCount = isDivina ? divina.length : giant.length

  // Build each index once; warm and cold reuse the same instance.
  const warmIndex = scenario.buildFrozen()
  const coldIndex = scenario.buildFrozen()

  const search = scenario.search.map(({ label, query, opts }) => {
    const warm = benchSearch(warmIndex, query, opts, ITERS)
    const cold = benchSearchColdReset(coldIndex, query, opts, ITERS)
    const fresh = isDivina
      ? benchSearchFreshInstance(scenario.buildFrozen, query, opts, FRESH_INSTANCE_ITERS)
      : null
    return {
      label,
      query,
      warmP50: Number(warm.p50.toFixed(4)),
      warmP95: Number(warm.p95.toFixed(4)),
      coldResetP50: Number(cold.p50.toFixed(4)),
      coldResetP95: Number(cold.p95.toFixed(4)),
      freshInstanceP50: fresh ? Number(fresh.p50.toFixed(4)) : null,
      coldResetVsWarmP50Pct: pctDeltaRound(warm.p50, cold.p50),
    }
  })
  return { label: scenario.label, documentCount, search }
}

const out = {
  capturedAt: new Date().toISOString(),
  purpose: 'volet3-cold-warm-frozen-search',
  iterations: ITERS,
  benchWarmup: 200,
  scenarios: scenarios.map(runScenario),
}

const outPath = join(BASELINES, 'volet3-cold-warm.json')
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')

/** Map our scenario labels to baseline scenario keys (reference.json uses `id`). */
const SCENARIO_KEY_ALIASES = {
  'divina-storeFields': ['divina-storeFields'],
  'giantVocabulary-50k': ['giantVocabulary-50k'],
  'giantVocabulary-50k-ref-queries': ['extreme-giantVocabulary', 'giantVocabulary-50k'],
}

function findRefScenario (ref, scenarioLabel) {
  const keys = SCENARIO_KEY_ALIASES[scenarioLabel] ?? [scenarioLabel]
  return ref.scenarios.find(s => keys.includes(s.label) || keys.includes(s.id))
}

function compareRef (refPath, label) {
  let ref
  try {
    ref = JSON.parse(readFileSync(join(BASELINES, refPath), 'utf8'))
  } catch {
    console.log(`\n(no ${refPath})`)
    return
  }
  console.log(`\n=== vs ${label} (${refPath}) ===`)
  for (const scen of out.scenarios) {
    const refScen = findRefScenario(ref, scen.label)
    if (!refScen) continue
    console.log(`\n${scen.label}:`)
    for (const q of scen.search) {
      const rq = refScen.search.find(x => x.label === q.label)
      if (!rq) continue
      const base = rq.frozenP50 ?? rq.warmP50
      if (base == null) continue
      console.log(
        `  ${q.label.padEnd(12)} warm ${q.warmP50} ms (Δ warm vs ref ${pctDeltaRound(base, q.warmP50)}%)`
        + ` | coldReset ${q.coldResetP50}`
        + (q.freshInstanceP50 != null ? ` | fresh ${q.freshInstanceP50}` : ''),
      )
    }
  }
}

console.log('Wrote', outPath)
compareRef('reference.json', '8.3.3 reference')
compareRef('volet3-no-cache.json', 'volet3 no string cache')
compareRef('volet3-baseline.json', 'volet3 with string cache')
