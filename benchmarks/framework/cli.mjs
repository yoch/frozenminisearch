#!/usr/bin/env node
/**
 * Unified benchmark CLI — profiles: vs-reference | regression | dev
 * Usage:
 *   node benchmarks/framework/cli.mjs run [--profile=dev] [--surfaces=search,build] [--quick]
 *   node benchmarks/framework/cli.mjs record [--profile=regression]
 *   node benchmarks/framework/cli.mjs diff [--run]
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseProfile, PROFILES } from './profiles.mjs'
import { parseSurfaces } from './surfaces.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'run'
const rest = argv.slice(1)
const profile = parseProfile(rest)
const surfaces = parseSurfaces(rest, profile)

function runNode(script, extraEnv = {}) {
  const env = { ...process.env, BENCH_PROFILE: profile, BENCH_SURFACES: surfaces.join(','), ...extraEnv }
  const r = spawnSync(process.execPath, ['--expose-gc', script, ...rest.filter(a => !a.startsWith('--profile=') && !a.startsWith('--surfaces=') && a !== '--quick')], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}

switch (cmd) {
  case 'run':
    if (profile === PROFILES.DEV) {
      runNode(join(root, 'benchmarks/compare.js'), {
        RUNS: '1',
        SEARCH_ITERATIONS: '10',
        BENCH_WARMUP: '20',
      })
    } else {
      runNode(join(root, 'benchmarks/compare.js'), {
        BENCH_USE_REFERENCE: profile === PROFILES.VS_REFERENCE ? '1' : '',
      })
    }
    break
  case 'record':
    runNode(join(root, 'benchmarks/captureBaseline.js'), {
      BENCH_USE_REFERENCE: profile === PROFILES.VS_REFERENCE ? '1' : '',
    })
    break
  case 'diff':
    if (rest.includes('--run')) {
      runNode(join(root, 'benchmarks/captureBaseline.js'))
    }
    runNode(join(root, 'benchmarks/diffBaseline.js'))
    break
  case 'history':
    runNode(join(root, 'benchmarks/scripts/record-history.mjs'))
    break
  default:
    console.error(`Unknown command: ${cmd}`)
    process.exit(1)
}
