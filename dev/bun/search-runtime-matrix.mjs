#!/usr/bin/env node
/**
 * Replay the complete public-search registry across Node 20/22/24 and Bun.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listAllCases } from './search-cases.mjs'

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

function runWorker (runtime, executable, caseKey, productRoot) {
  const runtimeArgs = runtime === 'bun'
    ? ['--no-install', worker]
    : [worker]
  const command = process.env.SEARCH_INV_NO_TASKSET === '1' ? executable : 'taskset'
  const args = process.env.SEARCH_INV_NO_TASKSET === '1'
    ? runtimeArgs
    : ['-c', process.env.SEARCH_INV_CPU || '0', executable, ...runtimeArgs]
  args.push(
    `--case=${caseKey}`,
    `--product-root=${productRoot}`,
    '--warmup=15',
    '--iterations=25',
    '--target-ms=25',
  )
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout.trim().split('\n').filter(Boolean).at(-1))
}

const productRoot = resolve(argValue('product-root') || root)
const reps = Number(argValue('reps') || 5)
const onlyRaw = argValue('only')
const cases = listAllCases({
  only: onlyRaw ? onlyRaw.split(',').map(value => value.trim()).filter(Boolean) : null,
})
const runtimes = [
  ['node20', process.env.NODE20_BIN],
  ['node22', process.env.NODE22_BIN],
  ['node24', process.env.NODE24_BIN || process.execPath],
  ['bun', process.env.BUN_BIN || 'bun'],
]
for (const [runtime, executable] of runtimes) {
  if (executable == null) throw new Error(`Missing executable for ${runtime}`)
}

mkdirSync(outDir, { recursive: true })
const rawRows = []
for (let rep = 0; rep < reps; rep++) {
  const runtimeOrder = rep % 2 === 0 ? runtimes : [...runtimes].reverse()
  const caseOrder = rep % 2 === 0 ? cases : [...cases].reverse()
  for (const [runtime, executable] of runtimeOrder) {
    for (const caze of caseOrder) {
      console.error(`[runtime-matrix] rep=${rep} ${runtime} ${caze.key}`)
      rawRows.push({
        ...runWorker(runtime, executable, caze.key, productRoot),
        rep,
        runtime,
      })
    }
  }
}

const summary = []
for (const caze of cases) {
  const entry = {
    caseKey: caze.key,
    runtimes: {},
  }
  const reference = rawRows.find(row => row.caseKey === caze.key && row.runtime === 'node24')
  for (const [runtime] of runtimes) {
    const rows = rawRows.filter(row => row.caseKey === caze.key && row.runtime === runtime)
    entry.runtimes[runtime] = {
      p50: Number(median(rows.map(row => row.timing.p50)).toFixed(6)),
      p95: Number(median(rows.map(row => row.timing.p95)).toFixed(6)),
      mad: Number(median(rows.map(row => row.timing.mad)).toFixed(6)),
      strictChecksumMatch: rows.every(row => row.checksum.hash === reference.checksum.hash),
      tolerantChecksumMatch: rows.every(row =>
        row.checksum.tolerantHash === reference.checksum.tolerantHash,
      ),
      shapeChecksumMatch: rows.every(row =>
        row.checksum.shapeHash === reference.checksum.shapeHash,
      ),
    }
  }
  summary.push(entry)
}

const failures = summary.filter(entry =>
  Object.values(entry.runtimes).some(runtime => !runtime.shapeChecksumMatch),
)
const payload = {
  capturedAt: new Date().toISOString(),
  productRoot,
  reps,
  commands: Object.fromEntries(runtimes),
  cases: cases.map(caze => caze.key),
  summary,
  shapeChecksumFailures: failures.map(entry => entry.caseKey),
  rawRows,
}
const out = join(outDir, 'search-runtime-matrix.json')
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({
  ok: failures.length === 0,
  out,
  cases: summary.length,
  shapeChecksumFailures: payload.shapeChecksumFailures,
}, null, 2))
