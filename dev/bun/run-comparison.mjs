#!/usr/bin/env node
/**
 * Orchestrate Node vs Bun CPU + peak-RSS comparisons.
 * Writes JSON under tmp/bun-results/ (gitignored via /tmp).
 *
 *   node dev/bun/run-comparison.mjs --mode=cpu
 *   node dev/bun/run-comparison.mjs --mode=memory
 *   node dev/bun/run-comparison.mjs --mode=all
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'tmp/bun-results')
const CPU_WORKER = join(__dirname, 'cpu-worker.mjs')
const PEAK_WORKER = join(__dirname, 'peak-rss-worker.mjs')

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
  const devs = xs.map((x) => Math.abs(x - med))
  return median(devs)
}

function runChild (runtime, script, args) {
  const cmd = runtime === 'bun' ? 'bun' : 'node'
  const prefix = runtime === 'bun'
    ? ['--no-install', '--expose-gc', script, ...args]
    : ['--expose-gc', script, ...args]
  const r = spawnSync(cmd, prefix, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`)
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

const CPU_SCENARIOS = [
  'divina-indexOnly',
  'divina-storeFields',
  'extreme-giantVocabulary',
  'extreme-largeDocuments',
  'extreme-highFrequency',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
]

const PEAK_SCENARIOS = [
  'divina-indexOnly',
  'divina-storeFields',
  'extreme-giantVocabulary',
  'extreme-largeDocuments',
  'extreme-highFrequency',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
]

const mode = argValue('mode') || 'all'
const reps = Number(argValue('reps') || 3)
mkdirSync(OUT_DIR, { recursive: true })

function runCpu () {
  const rows = []
  // Alternate order across reps to reduce thermal bias: rep0 node→bun, rep1 bun→node, ...
  for (let rep = 0; rep < reps; rep++) {
    const order = rep % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
    for (const scenarioId of CPU_SCENARIOS) {
      for (const runtime of order) {
        console.error(`[cpu] rep=${rep} ${runtime} ${scenarioId}`)
        const report = runChild(runtime, CPU_WORKER, [
          `--scenario=${scenarioId}`,
          '--runs=3',
          '--search-iters=40',
        ])
        rows.push({ rep, ...report })
      }
    }
  }

  const byKey = new Map()
  for (const row of rows) {
    const key = `${row.runtime}::${row.scenarioId}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(row)
  }

  const summary = []
  for (const scenarioId of CPU_SCENARIOS) {
    const nodeRows = byKey.get(`node::${scenarioId}`) || []
    const bunRows = byKey.get(`bun::${scenarioId}`) || []
    const metricKeys = ['fromDocumentsMs', 'fromJsonMs', 'saveBinaryMs', 'loadBinaryMs']
    const metrics = {}
    for (const k of metricKeys) {
      const n = nodeRows.map((r) => r.metrics[k])
      const b = bunRows.map((r) => r.metrics[k])
      const nMed = median(n)
      const bMed = median(b)
      metrics[k] = {
        nodeMedianMs: Number(nMed.toFixed(3)),
        bunMedianMs: Number(bMed.toFixed(3)),
        ratioBunOverNode: nMed > 0 ? Number((bMed / nMed).toFixed(3)) : null,
        nodeMadMs: Number(mad(n, nMed).toFixed(3)),
        bunMadMs: Number(mad(b, bMed).toFixed(3)),
      }
    }
    const searchLabels = nodeRows[0]?.metrics.search.map((s) => s.label) || []
    const search = {}
    for (const label of searchLabels) {
      const n = nodeRows.map((r) => r.metrics.search.find((s) => s.label === label)?.p50Ms).filter((x) => x != null)
      const b = bunRows.map((r) => r.metrics.search.find((s) => s.label === label)?.p50Ms).filter((x) => x != null)
      const nMed = median(n)
      const bMed = median(b)
      search[label] = {
        nodeMedianMs: Number(nMed.toFixed(4)),
        bunMedianMs: Number(bMed.toFixed(4)),
        ratioBunOverNode: nMed > 0 ? Number((bMed / nMed).toFixed(3)) : null,
      }
    }
    summary.push({ scenarioId, metrics, search })
  }

  const payload = {
    capturedAt: new Date().toISOString(),
    kind: 'cpu',
    reps,
    scenarios: CPU_SCENARIOS,
    summary,
    raw: rows,
  }
  const out = join(OUT_DIR, 'cpu-comparison.json')
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
  console.error(`[cpu] wrote ${out}`)
  return payload
}

function runMemory () {
  const rows = []
  for (let rep = 0; rep < reps; rep++) {
    const order = rep % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
    for (const scenarioId of PEAK_SCENARIOS) {
      for (const workload of ['build', 'loadBinary', 'search', 'mutable-addAll']) {
        for (const runtime of order) {
          const args = [`--workload=${workload}`, `--scenario=${scenarioId}`]
          if (workload === 'search') {
            let q = 'inferno'
            if (scenarioId.startsWith('extreme-giant')) q = 'unique12345'
            else if (scenarioId.startsWith('extreme-high') || scenarioId.startsWith('docId')) q = 'alpha'
            else if (scenarioId.startsWith('extreme-large')) q = 'lorem'
            args.push(`--query=${q}`)
          }
          console.error(`[mem] rep=${rep} ${runtime} ${workload} ${scenarioId}`)
          try {
            const report = runChild(runtime, PEAK_WORKER, args)
            rows.push({ rep, ...report })
          } catch (err) {
            rows.push({
              rep,
              runtime,
              workload,
              scenarioId,
              ok: false,
              error: String(err),
            })
          }
        }
      }
    }
  }

  // Medicaments fixtures: loadBinaryFile (field names embedded in snapshot)
  const fixturesDir = join(ROOT, 'benchmarks/fixtures/medicaments-indexes')
  const specs = [
    { id: 'bdpm-presentations', file: 'bdpm_presentations.msbin' },
    { id: 'bdpm-specialites', file: 'bdpm_specialites.msbin' },
    { id: 'bdpm-compositions', file: 'bdpm_compositions.msbin' },
    { id: 'bdpm-mitm', file: 'bdpm_mitm.msbin' },
    { id: 'bdpm-substances', file: 'bdpm_substances.msbin' },
    { id: 'bdpm-generiques', file: 'bdpm_generiques.msbin' },
    { id: 'vet-medicaments', file: 'vet_medicaments.msbin' },
  ]

  for (let rep = 0; rep < reps; rep++) {
    const order = rep % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
    for (const spec of specs) {
      const file = join(fixturesDir, spec.file)
      if (!existsSync(file)) continue
      for (const runtime of order) {
        console.error(`[mem] rep=${rep} ${runtime} loadBinaryFile ${spec.id}`)
        try {
          const report = runChild(runtime, PEAK_WORKER, [
            '--workload=loadBinaryFile',
            `--file=${file}`,
            '--fields=',
            '--storeFields=',
            '--query=a',
            `--scenario=${spec.id}`,
          ])
          rows.push({ rep, scenarioId: spec.id, ...report })
        } catch (err) {
          rows.push({
            rep,
            runtime,
            workload: 'loadBinaryFile',
            scenarioId: spec.id,
            ok: false,
            error: String(err),
          })
        }
      }
    }
  }

  const summary = aggregatePeak(rows)
  const payload = {
    capturedAt: new Date().toISOString(),
    kind: 'memory-peak-rss',
    reps,
    note: 'Primary cross-runtime metric is maxRssOsMb (Linux ru_maxrss). heapUsed is runtime-specific and not compared across engines.',
    summary,
    raw: rows,
  }
  const out = join(OUT_DIR, 'memory-peak-comparison.json')
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
  console.error(`[mem] wrote ${out}`)
  return payload
}

function aggregatePeak (rows) {
  const okRows = rows.filter((r) => r.ok !== false && r.maxRssOsMb != null)
  const keys = new Set(okRows.map((r) => `${r.workload}::${r.scenarioId}`))
  const out = []
  for (const key of [...keys].sort()) {
    const [workload, scenarioId] = key.split('::')
    const node = okRows.filter((r) => r.runtime === 'node' && r.workload === workload && r.scenarioId === scenarioId)
    const bun = okRows.filter((r) => r.runtime === 'bun' && r.workload === workload && r.scenarioId === scenarioId)
    if (!node.length || !bun.length) continue
    const nRss = node.map((r) => r.maxRssOsMb)
    const bRss = bun.map((r) => r.maxRssOsMb)
    const nMed = median(nRss)
    const bMed = median(bRss)
    out.push({
      workload,
      scenarioId,
      nodeMaxRssOsMb: Number(nMed.toFixed(3)),
      bunMaxRssOsMb: Number(bMed.toFixed(3)),
      ratioBunOverNode: nMed > 0 ? Number((bMed / nMed).toFixed(3)) : null,
      nodePeakSampledRssMb: Number(median(node.map((r) => r.peakSampledRssMb)).toFixed(3)),
      bunPeakSampledRssMb: Number(median(bun.map((r) => r.peakSampledRssMb)).toFixed(3)),
      nodeElapsedMs: Number(median(node.map((r) => r.elapsedMs)).toFixed(1)),
      bunElapsedMs: Number(median(bun.map((r) => r.elapsedMs)).toFixed(1)),
    })
  }
  return out
}

let cpuPayload = null
let memPayload = null
if (mode === 'cpu' || mode === 'all') cpuPayload = runCpu()
if (mode === 'memory' || mode === 'all') memPayload = runMemory()

writeFileSync(join(OUT_DIR, 'comparison-index.json'), `${JSON.stringify({
  capturedAt: new Date().toISOString(),
  mode,
  cpu: cpuPayload ? 'cpu-comparison.json' : null,
  memory: memPayload ? 'memory-peak-comparison.json' : null,
}, null, 2)}\n`)

console.log(JSON.stringify({
  ok: true,
  mode,
  cpuScenarios: cpuPayload?.summary?.length ?? 0,
  memoryRows: memPayload?.summary?.length ?? 0,
}))
