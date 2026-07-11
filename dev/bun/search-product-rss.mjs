#!/usr/bin/env node
/**
 * Compare OS peak RSS for two public-product builds.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const worker = join(here, 'search-product-worker.mjs')
const outDir = join(root, 'tmp/bun-results')
const defaultCases = [
  'gate-threshold-1024:sequential',
  'gate-threshold-1024:broad-first',
  'gate-threshold-1536:sequential',
  'gate-threshold-1536:broad-first',
  'extreme-giantVocabulary:AND+prefix',
  'extreme-largeDocuments:AND',
  'extreme-highFrequency:AND',
]

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find(arg => arg.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function makeRandom (seed) {
  let state = seed >>> 0
  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1)
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61)
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
}

function bootstrapMedian (values, random, iterations = 3000) {
  const medians = []
  for (let i = 0; i < iterations; i++) {
    const draw = []
    for (let j = 0; j < values.length; j++) {
      draw.push(values[(random() * values.length) | 0])
    }
    medians.push(median(draw))
  }
  medians.sort((a, b) => a - b)
  return {
    lo: medians[Math.floor(medians.length * 0.025)],
    hi: medians[Math.floor(medians.length * 0.975)],
  }
}

function runMeasured (runtime, productRoot, caseKey) {
  const executable = runtime === 'bun'
    ? (process.env.BUN_BIN || 'bun')
    : process.execPath
  const runtimeArgs = runtime === 'bun' ? ['--no-install', worker] : [worker]
  const args = [
    '-f', '__MAX_RSS_KB__:%M',
    'taskset', '-c', process.env.SEARCH_INV_CPU || '0',
    executable,
    ...runtimeArgs,
    `--case=${caseKey}`,
    `--product-root=${productRoot}`,
    '--warmup=8',
    '--iterations=12',
    '--target-ms=20',
  ]
  const result = spawnSync('/usr/bin/time', args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`/usr/bin/time ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  const match = result.stderr.match(/__MAX_RSS_KB__:(\d+)/)
  if (match == null) throw new Error(`Peak RSS marker missing:\n${result.stderr}`)
  return {
    report: JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1)),
    peakRssKb: Number(match[1]),
  }
}

const baselineRoot = resolve(argValue('baseline-root') || root)
const treatmentRaw = argValue('treatment-root')
if (treatmentRaw == null) throw new Error('Missing --treatment-root=<worktree>')
const treatmentRoot = resolve(treatmentRaw)
const reps = Number(argValue('reps') || 7)
const onlyRaw = argValue('only')
const cases = onlyRaw
  ? onlyRaw.split(',').map(value => value.trim()).filter(Boolean)
  : defaultCases
const roots = { baseline: baselineRoot, treatment: treatmentRoot }
const random = makeRandom(0x525353)
const rawRows = []

mkdirSync(outDir, { recursive: true })
for (let rep = 0; rep < reps; rep++) {
  const runtimeOrder = rep % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
  const caseOrder = rep % 2 === 0 ? cases : [...cases].reverse()
  const variantOrder = rep % 4 === 0 || rep % 4 === 3
    ? ['baseline', 'treatment']
    : ['treatment', 'baseline']
  for (const runtime of runtimeOrder) {
    for (const caseKey of caseOrder) {
      for (const variant of variantOrder) {
        console.error(`[product-rss] rep=${rep} ${runtime} ${caseKey} ${variant}`)
        rawRows.push({
          rep,
          runtime,
          caseKey,
          variant,
          ...runMeasured(runtime, roots[variant], caseKey),
        })
      }
    }
  }
}

const summary = []
for (const caseKey of cases) {
  for (const runtime of ['node', 'bun']) {
    const baseline = rawRows
      .filter(row => row.caseKey === caseKey && row.runtime === runtime && row.variant === 'baseline')
      .map(row => row.peakRssKb)
    const treatment = rawRows
      .filter(row => row.caseKey === caseKey && row.runtime === runtime && row.variant === 'treatment')
      .map(row => row.peakRssKb)
    const baselineMedianKb = median(baseline)
    const treatmentMedianKb = median(treatment)
    const ratios = []
    for (let rep = 0; rep < reps; rep++) {
      const baselineRow = rawRows.find(row =>
        row.rep === rep && row.caseKey === caseKey
        && row.runtime === runtime && row.variant === 'baseline',
      )
      const treatmentRow = rawRows.find(row =>
        row.rep === rep && row.caseKey === caseKey
        && row.runtime === runtime && row.variant === 'treatment',
      )
      ratios.push(treatmentRow.peakRssKb / baselineRow.peakRssKb)
    }
    const ratioCi = bootstrapMedian(ratios, random)
    summary.push({
      caseKey,
      runtime,
      baselineMedianKb,
      treatmentMedianKb,
      deltaKb: treatmentMedianKb - baselineMedianKb,
      ratio: Number((treatmentMedianKb / baselineMedianKb).toFixed(4)),
      pairedRatio: Number(median(ratios).toFixed(4)),
      ratioCi95: {
        lo: Number(ratioCi.lo.toFixed(4)),
        hi: Number(ratioCi.hi.toFixed(4)),
      },
    })
  }
}
const regressions = summary.filter(row =>
  row.pairedRatio > 1.03 && row.ratioCi95.lo > 1.03,
)
const payload = {
  capturedAt: new Date().toISOString(),
  baselineRoot,
  treatmentRoot,
  reps,
  summary,
  regressionsOver3Percent: regressions,
  rawRows,
}
const out = join(outDir, 'search-product-rss-gate-1024.json')
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({
  ok: regressions.length === 0,
  out,
  regressionsOver3Percent: regressions,
}, null, 2))
if (regressions.length > 0) process.exitCode = 1
