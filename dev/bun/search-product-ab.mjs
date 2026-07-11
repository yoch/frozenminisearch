#!/usr/bin/env node
/**
 * Paired old/new public-product A/B.
 *
 * Each side runs in a fresh process and imports its own dist/cjs build. Variant
 * order follows ABBA across reps; runtime and case order are also alternated.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCT_AB_CASE_KEYS } from './search-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const worker = join(here, 'search-product-worker.mjs')
const outDir = join(root, 'tmp/bun-results')

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

function bootstrapMedian (values, random, iterations = 5000) {
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
    median: median(values),
    hi: medians[Math.floor(medians.length * 0.975)],
  }
}

function runWorker (runtime, args) {
  const bunBin = process.env.BUN_BIN || 'bun'
  const runtimeCommand = runtime === 'bun' ? bunBin : process.execPath
  const runtimeArgs = runtime === 'bun'
    ? ['--no-install', worker, ...args]
    : [worker, ...args]
  const command = process.env.SEARCH_INV_NO_TASKSET === '1'
    ? runtimeCommand
    : 'taskset'
  const commandArgs = process.env.SEARCH_INV_NO_TASKSET === '1'
    ? runtimeArgs
    : ['-c', process.env.SEARCH_INV_CPU || '0', runtimeCommand, ...runtimeArgs]
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1))
}

function variantOrderForRep (rep) {
  return rep % 4 === 0 || rep % 4 === 3
    ? ['baseline', 'treatment']
    : ['treatment', 'baseline']
}

function classifyRuntime (summary) {
  const significantGain5 = summary.ratio <= 0.95 && summary.ratioCi95.hi < 1
  const significantGain10 = summary.ratio <= 0.90 && summary.ratioCi95.hi < 1
  const significantRegression = summary.ratio >= 1.03
    && summary.ratioCi95.lo > 1
    && summary.deltaMs > 0.05
  return { significantGain5, significantGain10, significantRegression }
}

const baselineRoot = resolve(argValue('baseline-root') || root)
const treatmentRaw = argValue('treatment-root')
if (treatmentRaw == null) throw new Error('Missing --treatment-root=<worktree>')
const treatmentRoot = resolve(treatmentRaw)
const reps = Number(argValue('reps') || 15)
const seed = Number(argValue('seed') || 0x10242048)
const outputName = argValue('output') || 'search-product-ab-gate-1024.json'
const onlyRaw = argValue('only')
const cases = onlyRaw
  ? onlyRaw.split(',').map(value => value.trim()).filter(Boolean)
  : PRODUCT_AB_CASE_KEYS
const random = makeRandom(seed)
const productRoots = {
  baseline: baselineRoot,
  treatment: treatmentRoot,
}

mkdirSync(outDir, { recursive: true })
const rawRows = []

for (let rep = 0; rep < reps; rep++) {
  const runtimeOrder = rep % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
  const caseOrder = rep % 2 === 0 ? cases : [...cases].reverse()
  for (const runtime of runtimeOrder) {
    for (const caseKey of caseOrder) {
      for (const variant of variantOrderForRep(rep)) {
        console.error(`[product-ab] rep=${rep} ${runtime} ${caseKey} ${variant}`)
        const report = runWorker(runtime, [
          `--case=${caseKey}`,
          `--product-root=${productRoots[variant]}`,
          '--warmup=20',
          '--iterations=30',
          '--target-ms=25',
        ])
        rawRows.push({ rep, variant, ...report })
      }
    }
  }
}

const summary = []
for (const caseKey of cases) {
  const entry = { caseKey, runtimes: {} }
  for (const runtime of ['node', 'bun']) {
    const pairs = []
    for (let rep = 0; rep < reps; rep++) {
      const baseline = rawRows.find(row =>
        row.rep === rep
        && row.caseKey === caseKey
        && row.runtime === runtime
        && row.variant === 'baseline',
      )
      const treatment = rawRows.find(row =>
        row.rep === rep
        && row.caseKey === caseKey
        && row.runtime === runtime
        && row.variant === 'treatment',
      )
      if (baseline == null || treatment == null) continue
      pairs.push({
        rep,
        baselineMs: baseline.timing.p50,
        treatmentMs: treatment.timing.p50,
        ratio: treatment.timing.p50 / baseline.timing.p50,
        checksumMatch: baseline.checksum.hash === treatment.checksum.hash,
        baselineRssAfter: baseline.memory?.rssAfter ?? null,
        treatmentRssAfter: treatment.memory?.rssAfter ?? null,
        baselineRssDelta: baseline.memory?.rssDelta ?? null,
        treatmentRssDelta: treatment.memory?.rssDelta ?? null,
      })
    }
    const ratios = pairs.map(pair => pair.ratio)
    const baselineMedian = median(pairs.map(pair => pair.baselineMs))
    const treatmentMedian = median(pairs.map(pair => pair.treatmentMs))
    const memoryPairs = pairs.filter(pair =>
      pair.baselineRssAfter != null && pair.treatmentRssAfter != null,
    )
    const ratioCi = bootstrapMedian(ratios, random)
    entry.runtimes[runtime] = {
      baselineMs: Number(baselineMedian.toFixed(6)),
      treatmentMs: Number(treatmentMedian.toFixed(6)),
      deltaMs: Number((treatmentMedian - baselineMedian).toFixed(6)),
      ratio: Number(median(ratios).toFixed(4)),
      ratioCi95: {
        lo: Number(ratioCi.lo.toFixed(4)),
        hi: Number(ratioCi.hi.toFixed(4)),
      },
      checksumMatch: pairs.every(pair => pair.checksumMatch),
      rss: memoryPairs.length > 0
        ? {
            baselineAfter: median(memoryPairs.map(pair => pair.baselineRssAfter)),
            treatmentAfter: median(memoryPairs.map(pair => pair.treatmentRssAfter)),
            deltaAfter: median(memoryPairs.map(pair =>
              pair.treatmentRssAfter - pair.baselineRssAfter,
            )),
            baselineGrowth: median(memoryPairs.map(pair => pair.baselineRssDelta)),
            treatmentGrowth: median(memoryPairs.map(pair => pair.treatmentRssDelta)),
            pairs: memoryPairs.length,
          }
        : null,
      pairs,
    }
  }
  const node = entry.runtimes.node
  const bun = entry.runtimes.bun
  const nodeClass = classifyRuntime(node)
  const bunClass = classifyRuntime(bun)
  const hasGain = nodeClass.significantGain5 || bunClass.significantGain5
  const hasRegression = nodeClass.significantRegression || bunClass.significantRegression
  if (hasGain && hasRegression) {
    entry.classification = 'trade-off'
  } else if (hasRegression) {
    entry.classification = 'reject'
  } else if (
    (nodeClass.significantGain5 && bunClass.significantGain5)
    || (nodeClass.significantGain10 && !bunClass.significantRegression)
    || (bunClass.significantGain10 && !nodeClass.significantRegression)
  ) {
    entry.classification = 'neutral-win'
  } else if (
    node.ratioCi95.lo <= 1 && node.ratioCi95.hi >= 1
    && bun.ratioCi95.lo <= 1 && bun.ratioCi95.hi >= 1
    && Math.abs(node.deltaMs) <= 0.05
    && Math.abs(bun.deltaMs) <= 0.05
  ) {
    entry.classification = 'noop'
  } else {
    entry.classification = 'inconclusive'
  }
  summary.push(entry)
}

const globalRegressions = summary.filter(entry =>
  entry.classification === 'reject' || entry.classification === 'trade-off',
)
const checksumFailures = summary.filter(entry =>
  !entry.runtimes.node.checksumMatch || !entry.runtimes.bun.checksumMatch,
)
const payload = {
  capturedAt: new Date().toISOString(),
  baselineRoot,
  treatmentRoot,
  reps,
  seed,
  cases,
  command: process.argv,
  decision: checksumFailures.length > 0 || globalRegressions.length > 0
    ? 'reject'
    : summary.some(entry => entry.classification === 'neutral-win')
      ? 'candidate'
      : 'no-demonstrated-win',
  summary,
  checksumFailures: checksumFailures.map(entry => entry.caseKey),
  globalRegressions: globalRegressions.map(entry => entry.caseKey),
  rawRows,
}
const out = join(outDir, outputName)
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({
  ok: true,
  out,
  decision: payload.decision,
  classifications: Object.fromEntries(
    ['neutral-win', 'noop', 'inconclusive', 'trade-off', 'reject']
      .map(classification => [
        classification,
        summary.filter(entry => entry.classification === classification).length,
      ]),
  ),
}, null, 2))
