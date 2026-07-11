#!/usr/bin/env node
/**
 * A/B experiment runner for search hypotheses (one variant at a time).
 * Variants are selected via --variant= and implemented in the worker via
 * QueryEngineRunOptions / local micro-harnesses — no runtime detection in product.
 *
 *   node --import tsx dev/bun/search-ab.mjs --variant=gating-off --reps=5
 *   node --import tsx dev/bun/search-ab.mjs --variant=gate-policy --reps=5
 *   node --import tsx dev/bun/search-ab.mjs --variant=fuzzy-scratch --reps=5
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROFILE_CASE_KEYS } from './search-cases.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'tmp/bun-results')
const WORKER = join(__dirname, 'search-ab-worker.mjs')

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

function median (xs) {
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

function makeRandom (seed) {
  let state = seed >>> 0
  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1)
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61)
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
}

function bootstrapCi (xs, random, { iters = 2000 } = {}) {
  if (xs.length < 2) return null
  const samples = []
  for (let i = 0; i < iters; i++) {
    const draw = []
    for (let j = 0; j < xs.length; j++) draw.push(xs[(random() * xs.length) | 0])
    samples.push(median(draw))
  }
  samples.sort((a, b) => a - b)
  return {
    lo: samples[Math.floor(0.025 * samples.length)],
    hi: samples[Math.min(samples.length - 1, Math.floor(0.975 * samples.length))],
    median: median(xs),
  }
}

function runChild (runtime, args) {
  const bunBin = process.env.BUN_BIN || 'bun'
  let cmd
  let spawnArgs
  if (runtime === 'bun') {
    cmd = bunBin
    spawnArgs = ['--no-install', '--expose-gc', WORKER, ...args]
  } else {
    cmd = process.execPath
    spawnArgs = ['--expose-gc', '--import', 'tsx', WORKER, ...args]
  }
  spawnArgs = ['-c', process.env.SEARCH_INV_CPU || '0', cmd, ...spawnArgs]
  cmd = 'taskset'
  const r = spawnSync(cmd, spawnArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${spawnArgs.join(' ')} failed:\n${r.stderr || r.stdout}`)
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

const variant = argValue('variant') || 'gating-off'
const reps = Number(argValue('reps') || 5)
const seed = Number(argValue('seed') || 0xabba2026)
const onlyRaw = argValue('only')
const cases = onlyRaw
  ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : PROFILE_CASE_KEYS
const random = makeRandom(seed)

mkdirSync(OUT_DIR, { recursive: true })
console.error(`[ab] variant=${variant} reps=${reps} cases=${cases.length}`)

const raw = []
for (let rep = 0; rep < reps; rep++) {
  const order = rep % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
  const caseOrder = rep % 2 === 0 ? cases : [...cases].reverse()
  const measurementOrder = rep % 4 === 0 || rep % 4 === 3
    ? 'baseline-first'
    : 'treatment-first'
  for (const caseKey of caseOrder) {
    for (const runtime of order) {
      console.error(`[ab] rep=${rep} ${runtime} ${caseKey}`)
      try {
        const report = runChild(runtime, [
          `--case=${caseKey}`,
          `--variant=${variant}`,
          '--warmup=20',
          '--iterations=30',
          '--target-ms=25',
          `--order=${measurementOrder}`,
        ])
        raw.push({ rep, ...report })
      } catch (err) {
        raw.push({ rep, runtime, caseKey, ok: false, error: String(err) })
      }
    }
  }
}

const byKey = new Map()
for (const row of raw.filter((r) => r.ok !== false)) {
  const k = `${row.caseKey}::${row.runtime}`
  if (!byKey.has(k)) byKey.set(k, [])
  byKey.get(k).push(row)
}

const summary = []
for (const caseKey of cases) {
  const entry = { caseKey, runtimes: {} }
  for (const runtime of ['node', 'bun']) {
    const rows = byKey.get(`${caseKey}::${runtime}`) || []
    if (!rows.length) continue
    const base = rows.map((r) => r.baseline?.p50).filter((x) => x != null)
    const treat = rows.map((r) => r.treatment?.p50).filter((x) => x != null)
    const ratios = rows
      .filter((r) => r.baseline?.p50 > 0 && r.treatment?.p50 != null)
      .map((r) => r.treatment.p50 / r.baseline.p50)
    const baseMed = median(base)
    const treatMed = median(treat)
    const ratioMed = ratios.length ? median(ratios) : null
    const ratioCi = ratios.length >= 3 ? bootstrapCi(ratios, random) : null
    entry.runtimes[runtime] = {
      baselineMs: Number(baseMed.toFixed(6)),
      treatmentMs: Number(treatMed.toFixed(6)),
      ratio: ratioMed == null ? null : Number(ratioMed.toFixed(4)),
      ratioCi95: ratioCi && {
        lo: Number(ratioCi.lo.toFixed(4)),
        hi: Number(ratioCi.hi.toFixed(4)),
      },
      deltaMs: Number((treatMed - baseMed).toFixed(6)),
      checksumMatch: rows.every((r) => r.checksumMatch !== false),
    }
  }
  const n = entry.runtimes.node
  const b = entry.runtimes.bun
  let klass = 'incomplete'
  if (n && b && n.ratio != null && b.ratio != null) {
    const nGain5 = n.ratio <= 0.95 && n.ratioCi95?.hi < 1
    const bGain5 = b.ratio <= 0.95 && b.ratioCi95?.hi < 1
    const nGain10 = n.ratio <= 0.90 && n.ratioCi95?.hi < 1
    const bGain10 = b.ratio <= 0.90 && b.ratioCi95?.hi < 1
    const nReg = n.ratio >= 1.03 && n.ratioCi95?.lo > 1 && n.deltaMs > 0.05
    const bReg = b.ratio >= 1.03 && b.ratioCi95?.lo > 1 && b.deltaMs > 0.05
    if ((nGain5 && bGain5) || (nGain10 && !bReg) || (bGain10 && !nReg)) {
      klass = 'neutral-win'
    } else if ((n.ratioCi95 && n.ratioCi95.lo < 1 && n.ratioCi95.hi > 1)
      && (b.ratioCi95 && b.ratioCi95.lo < 1 && b.ratioCi95.hi > 1)
      && Math.abs(n.deltaMs) < 0.05 && Math.abs(b.deltaMs) < 0.05) {
      klass = 'noop'
    } else if ((nGain5 && bReg) || (bGain5 && nReg)) {
      klass = 'trade-off'
    } else if (nReg && bReg) {
      klass = 'reject'
    } else {
      klass = 'inconclusive'
    }
  }
  entry.classification = klass
  summary.push(entry)
}

const payload = {
  capturedAt: new Date().toISOString(),
  variant,
  reps,
  seed,
  note: 'ratio = treatment/baseline; <1 is faster. Classes: neutral-win|noop|trade-off|reject|inconclusive',
  summary,
  rawCount: raw.length,
  rawRows: raw,
}
const out = join(OUT_DIR, `search-ab-${variant}.json`)
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({
  ok: true,
  out,
  classes: Object.fromEntries(
    ['neutral-win', 'noop', 'trade-off', 'reject', 'inconclusive', 'incomplete']
      .map((c) => [c, summary.filter((s) => s.classification === c).length]),
  ),
}, null, 2))
