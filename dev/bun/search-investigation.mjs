#!/usr/bin/env node
/**
 * Orchestrate dual-runtime search investigation.
 *
 *   node dev/bun/search-investigation.mjs --phase=baseline --reps=5
 *   node dev/bun/search-investigation.mjs --phase=phases --reps=3
 *   node dev/bun/search-investigation.mjs --phase=all --reps=3
 *   node dev/bun/search-investigation.mjs --phase=baseline --only=divina-storeFields:fuzzy
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listAllCases, PROFILE_CASE_KEYS } from './search-cases.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'tmp/bun-results')
const WORKER = join(__dirname, 'search-phase-worker.mjs')

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

function mad (xs, med) {
  return median(xs.map((x) => Math.abs(x - med)))
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
  if (xs.length === 0) return null
  const samples = []
  for (let i = 0; i < iters; i++) {
    const draw = []
    for (let j = 0; j < xs.length; j++) draw.push(xs[(random() * xs.length) | 0])
    samples.push(median(draw))
  }
  samples.sort((a, b) => a - b)
  const lo = samples[Math.floor(0.025 * samples.length)]
  const hi = samples[Math.min(samples.length - 1, Math.floor(0.975 * samples.length))]
  return { lo, hi, median: median(xs) }
}

const CPU_AFFINITY = process.env.SEARCH_INV_CPU || '0'
const USE_TASKSET = process.env.SEARCH_INV_NO_TASKSET !== '1'

function runChildFixed (runtime, args) {
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
  if (USE_TASKSET) {
    spawnArgs = ['-c', CPU_AFFINITY, cmd, ...spawnArgs]
    cmd = 'taskset'
  }
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

const phase = argValue('phase') || 'all'
const reps = Number(argValue('reps') || 7)
const warmupProcs = Number(argValue('warmup-procs') || 1)
const seed = Number(argValue('seed') || 0x5eed1234)
const workerWarmup = Number(argValue('worker-warmup') || 20)
const workerIterations = Number(argValue('worker-iterations') || 30)
const targetMs = Number(argValue('target-ms') || 25)
const onlyRaw = argValue('only')
const only = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : null
const workerMode = phase === 'phases' ? 'phases' : phase === 'baseline' ? 'baseline' : 'all'
const withWarmupCurve = (phase === 'baseline' || phase === 'all')
  && !process.argv.includes('--no-warmup-curve')
const allowFailures = process.argv.includes('--allow-failures')
const random = makeRandom(seed)

mkdirSync(OUT_DIR, { recursive: true })

const cases = listAllCases({ only })
console.error(`[search-inv] phase=${phase} warmupProcs=${warmupProcs} reps=${reps} cases=${cases.length}`)

// Discarded warmup processes (JIT / page cache), once per scenario+runtime.
const warmed = new Set()
for (let w = 0; w < warmupProcs; w++) {
  for (const caze of cases) {
    for (const runtime of ['node', 'bun']) {
      const key = `${runtime}::${caze.scenarioId}`
      if (warmed.has(key)) continue
      warmed.add(key)
      console.error(`[search-inv] warmup ${w} ${runtime} ${caze.scenarioId}`)
      try {
        runChildFixed(runtime, [
          `--case=${caze.key}`,
          `--mode=${workerMode}`,
          '--warmup=15',
          '--iterations=8',
          '--target-ms=15',
        ])
      } catch (err) {
        console.error(`[search-inv] warmup failed: ${err}`)
      }
    }
  }
}

const rawRows = []
for (let rep = 0; rep < reps; rep++) {
  const order = rep % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
  const caseOrder = rep % 2 === 0 ? cases : [...cases].reverse()
  const implementationOrder = rep % 2 === 0 ? 'frozen-first' : 'mutable-first'
  for (const caze of caseOrder) {
    for (const runtime of order) {
      console.error(`[search-inv] rep=${rep} ${runtime} ${caze.key}`)
      try {
        const args = [
          `--case=${caze.key}`,
          `--mode=${workerMode}`,
          `--warmup=${workerWarmup}`,
          `--iterations=${workerIterations}`,
          `--target-ms=${targetMs}`,
          `--implementation-order=${implementationOrder}`,
        ]
        if (withWarmupCurve && rep === 0) args.push('--warmup-curve')
        const report = runChildFixed(runtime, args)
        rawRows.push({ rep, ...report })
      } catch (err) {
        const failure = {
          rep,
          runtime,
          caseKey: caze.key,
          ok: false,
          error: String(err),
        }
        rawRows.push(failure)
        if (!allowFailures) throw err
      }
    }
  }
}

function groupByCase (rows) {
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.caseKey)) map.set(row.caseKey, [])
    map.get(row.caseKey).push(row)
  }
  return map
}

const byCase = groupByCase(rawRows.filter((r) => r.ok !== false))
const summary = []

for (const [caseKey, rows] of [...byCase.entries()].sort()) {
  const nodeRows = rows.filter((r) => r.runtime === 'node')
  const bunRows = rows.filter((r) => r.runtime === 'bun')
  if (!nodeRows.length || !bunRows.length) continue

  const F_node = nodeRows.map((r) => r.frozen?.p50).filter((x) => x != null)
  const F_bun = bunRows.map((r) => r.frozen?.p50).filter((x) => x != null)
  const M_node = nodeRows.map((r) => r.mutable?.p50).filter((x) => x != null)
  const M_bun = bunRows.map((r) => r.mutable?.p50).filter((x) => x != null)

  const fNode = median(F_node)
  const fBun = median(F_bun)
  const mNode = M_node.length ? median(M_node) : null
  const mBun = M_bun.length ? median(M_bun) : null

  const Q_node = mNode != null && mNode > 0 ? fNode / mNode : null
  const Q_bun = mBun != null && mBun > 0 ? fBun / mBun : null
  const I = Q_node != null && Q_bun != null && Q_node > 0 ? Q_bun / Q_node : null
  const F_ratio = fNode > 0 ? fBun / fNode : null
  const M_ratio = mNode != null && mNode > 0 ? mBun / mNode : null

  // Per-rep I for CI
  const I_reps = []
  for (let rep = 0; rep < reps; rep++) {
    const n = nodeRows.find((r) => r.rep === rep)
    const b = bunRows.find((r) => r.rep === rep)
    if (!n?.frozen || !b?.frozen || !n?.mutable || !b?.mutable) continue
    if (n.mutable.p50 <= 0 || n.frozen.p50 <= 0) continue
    const qn = n.frozen.p50 / n.mutable.p50
    const qb = b.frozen.p50 / b.mutable.p50
    if (qn > 0) I_reps.push(qb / qn)
  }
  const I_ci = I_reps.length >= 3 ? bootstrapCi(I_reps, random) : null

  const absFrozenMs = Math.max(fNode, fBun)
  const absoluteFrozenGapMs = Math.abs(fBun - fNode)
  const material = absoluteFrozenGapMs >= 0.05
  const interactionSignificant = I_ci != null && (I_ci.lo > 1 || I_ci.hi < 1)
  const frozenDriven = F_ratio != null && M_ratio != null
    && Math.abs(Math.log2(F_ratio)) > Math.abs(Math.log2(M_ratio))

  const triageScore = I == null
    ? (F_ratio != null ? Math.abs(Math.log2(F_ratio)) * Math.log10(1 + absFrozenMs * 1000) : 0)
    : Math.abs(Math.log2(I)) * Math.log10(1 + absFrozenMs * 1000)

  const phases = {}
  for (const runtime of ['node', 'bun']) {
    const rs = rows.filter((r) => r.runtime === runtime && r.phases)
    if (!rs.length) continue
    const pick = (path) => median(rs.map((r) => {
      const parts = path.split('.')
      let v = r.phases
      for (const p of parts) v = v?.[p]
      return v
    }).filter((x) => typeof x === 'number'))
    phases[runtime] = {
      L0: pick('L0.p50'),
      executeRaw: pick('executeRaw.p50'),
      gatingDisabled: pick('gatingDisabled.p50'),
      finalize: pick('finalize.p50'),
      search: pick('search.p50'),
      termResolve: pick('termResolve.p50'),
      rawResultCount: pick('rawResultCount'),
    }
  }

  summary.push({
    caseKey,
    scenarioId: nodeRows[0].scenarioId,
    label: nodeRows[0].label,
    kind: nodeRows[0].kind,
    F_nodeMs: Number(fNode.toFixed(6)),
    F_bunMs: Number(fBun.toFixed(6)),
    M_nodeMs: mNode == null ? null : Number(mNode.toFixed(6)),
    M_bunMs: mBun == null ? null : Number(mBun.toFixed(6)),
    F_bunOverNode: F_ratio == null ? null : Number(F_ratio.toFixed(4)),
    M_bunOverNode: M_ratio == null ? null : Number(M_ratio.toFixed(4)),
    Q_node: Q_node == null ? null : Number(Q_node.toFixed(4)),
    Q_bun: Q_bun == null ? null : Number(Q_bun.toFixed(4)),
    I: I == null ? null : Number(I.toFixed(4)),
    log2I: I == null || I <= 0 ? null : Number(Math.log2(I).toFixed(4)),
    I_ci95: I_ci == null ? null : {
      lo: Number(I_ci.lo.toFixed(4)),
      hi: Number(I_ci.hi.toFixed(4)),
    },
    F_madNode: Number(mad(F_node, fNode).toFixed(6)),
    F_madBun: Number(mad(F_bun, fBun).toFixed(6)),
    F_p95Node: Number(median(nodeRows.map(row => row.frozen?.p95).filter(Number.isFinite)).toFixed(6)),
    F_p95Bun: Number(median(bunRows.map(row => row.frozen?.p95).filter(Number.isFinite)).toFixed(6)),
    M_p95Node: M_node.length
      ? Number(median(nodeRows.map(row => row.mutable?.p95).filter(Number.isFinite)).toFixed(6))
      : null,
    M_p95Bun: M_bun.length
      ? Number(median(bunRows.map(row => row.mutable?.p95).filter(Number.isFinite)).toFixed(6))
      : null,
    material,
    absoluteFrozenGapMs: Number(absoluteFrozenGapMs.toFixed(6)),
    interactionSignificant,
    frozenDriven,
    triageScore: Number(triageScore.toFixed(4)),
    priority: interactionSignificant && material && (frozenDriven || I == null)
      ? 'high'
      : (material && F_ratio != null && (F_ratio > 1.2 || F_ratio < 0.8) ? 'medium' : 'low'),
    checksumNode: nodeRows[0].frozen?.checksum ?? null,
    checksumBun: bunRows[0].frozen?.checksum ?? null,
    checksumMatch: rows.every(row =>
      row.frozen?.checksum?.strictHash === nodeRows[0].frozen?.checksum?.strictHash,
    ),
    frozenMutableParity: M_node.length
      ? {
          counts: rows.every(row => row.frozenMutableParity?.count === true),
          shape: rows.every(row => row.frozenMutableParity?.shape === true),
          strict: rows.every(row => row.frozenMutableParity?.strict === true),
          tolerant: rows.every(row => row.frozenMutableParity?.tolerant === true),
        }
      : null,
    phases,
  })
}

summary.sort((a, b) => b.triageScore - a.triageScore)

const payload = {
  capturedAt: new Date().toISOString(),
  phase,
  reps,
  seed,
  workerMode,
  command: process.argv,
  note: 'I = (F_bun/M_bun) / (F_node/M_node). I>1 => Frozen loses relative advantage under Bun (possible V8 specialization). Proxy for triage only.',
  profileHints: PROFILE_CASE_KEYS,
  summary,
  rawCount: rawRows.length,
  failures: rawRows.filter(row => row.ok === false),
  rawRows,
}

const outName = phase === 'all'
  ? 'search-investigation.json'
  : `search-investigation-${phase}.json`
const out = join(OUT_DIR, outName)
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)

const high = summary.filter((s) => s.priority === 'high')
console.log(JSON.stringify({
  ok: true,
  out,
  cases: summary.length,
  highPriority: high.map((s) => ({
    caseKey: s.caseKey,
    I: s.I,
    F_bunOverNode: s.F_bunOverNode,
    F_nodeMs: s.F_nodeMs,
    F_bunMs: s.F_bunMs,
    triageScore: s.triageScore,
  })),
}, null, 2))
