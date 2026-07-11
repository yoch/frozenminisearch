#!/usr/bin/env node
/**
 * Capture CPU profiles for material search cases (Node V8 + Bun JSC).
 *
 *   node --import tsx dev/bun/search-profile.mjs
 *   node --import tsx dev/bun/search-profile.mjs --only=divina-storeFields:fuzzy
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROFILE_CASE_KEYS } from './search-cases.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const OUT = join(ROOT, 'tmp/bun-results/profiles-clean')
const WORKER = join(__dirname, 'search-profile-worker.mjs')

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

const onlyRaw = argValue('only')
const cases = onlyRaw
  ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : PROFILE_CASE_KEYS

mkdirSync(join(OUT, 'node'), { recursive: true })
mkdirSync(join(OUT, 'bun'), { recursive: true })

const summary = []

for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
  const caseKey = cases[caseIndex]
  const safe = caseKey.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const runtimeOrder = caseIndex % 2 === 0 ? ['node', 'bun'] : ['bun', 'node']
  for (const runtime of runtimeOrder) {
    console.error(`[profile] ${runtime} ${caseKey}`)
    const runtimeDir = join(OUT, runtime, safe)
    mkdirSync(runtimeDir, { recursive: true })
    const runtimeCommand = runtime === 'bun'
      ? (process.env.BUN_BIN || 'bun')
      : process.execPath
    const runtimeArgs = runtime === 'bun'
      ? [
          '--no-install',
          '--cpu-prof',
          '--cpu-prof-md',
          `--cpu-prof-dir=${runtimeDir}`,
          WORKER,
        ]
      : [
          '--cpu-prof',
          `--cpu-prof-dir=${runtimeDir}`,
          WORKER,
        ]
    const profiled = spawnSync('taskset', [
      '-c', process.env.SEARCH_INV_CPU || '0',
      runtimeCommand,
      ...runtimeArgs,
      `--case=${caseKey}`,
      `--product-root=${ROOT}`,
      '--warmup-calls=500',
      '--duration-ms=8000',
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env })
    if (profiled.status !== 0) {
      throw new Error(`${runtime} profile failed:\n${profiled.stderr || profiled.stdout}`)
    }
    const profileFiles = readdirSync(runtimeDir)
      .filter(file => file.endsWith('.cpuprofile') || file.endsWith('.md'))
    summary.push({
      caseKey,
      runtime,
      status: profiled.status,
      report: JSON.parse(profiled.stdout.trim().split('\n').filter(Boolean).at(-1)),
      profileFiles: profileFiles.map(file => join(runtimeDir, file)),
      stderrTail: (profiled.stderr || '').slice(-500),
    })
  }
}

const out = join(OUT, 'profile-summary.json')
writeFileSync(out, `${JSON.stringify({ capturedAt: new Date().toISOString(), summary }, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, out, cases: cases.length }, null, 2))
