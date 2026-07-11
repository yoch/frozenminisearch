#!/usr/bin/env node
/**
 * Cross-runtime binary compatibility: Node↔Bun save/load matrix.
 *
 * Writes JSON report to tmp/bun-results/cross-runtime.json by default.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const OUT_DIR = join(ROOT, 'tmp/bun-results')
const SMOKE = join(__dirname, 'consumer-smoke.mjs')
const BUN_BIN = process.env.BUN_BIN || 'bun'

function run (cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`)
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

function loadWith (runtime, compression, b64) {
  const script = `
import FrozenMiniSearch from ${JSON.stringify(join(ROOT, 'dist/es/index.js'))};
const options = { fields: ['title', 'text'], storeFields: ['title'] };
const buf = Buffer.from(${JSON.stringify(b64)}, 'base64');
const loaded = FrozenMiniSearch.loadBinarySync(buf, options);
const ids = loaded.search('ishmael').map(r => r.id);
if (ids[0] !== 1) throw new Error('bad search after load');
console.log(JSON.stringify({ ok: true, runtime: ${JSON.stringify(runtime)}, compression: ${JSON.stringify(compression)}, ids }));
`
  const cmd = runtime === 'bun' ? BUN_BIN : process.execPath
  const args = runtime === 'bun'
    ? ['--no-install', '--eval', script]
    : ['--input-type=module', '-e', script]
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`load ${runtime}/${compression} failed:\n${r.stderr || r.stdout}`)
  }
  return JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop())
}

mkdirSync(OUT_DIR, { recursive: true })

const matrix = []
for (const saver of ['node', 'bun']) {
  const snapPath = join(OUT_DIR, `snapshots-${saver}.json`)
  const saved = saver === 'bun'
    ? run(BUN_BIN, ['--no-install', SMOKE, '--entry=es', '--emit-snapshots'], { FMS_OUT: snapPath })
    : run(process.execPath, [SMOKE, '--entry=es', '--emit-snapshots'], { FMS_OUT: snapPath })
  for (const compression of ['raw', 'zlib', 'zstd']) {
    for (const loader of ['node', 'bun']) {
      const loaded = loadWith(loader, compression, saved.snapshotsB64[compression])
      matrix.push({
        saver,
        loader,
        compression,
        ok: loaded.ok === true && loaded.ids?.[0] === 1,
        ids: loaded.ids,
      })
    }
  }
}

const entries = []
for (const entry of ['es', 'cjs', 'browser']) {
  for (const runtime of ['node', 'bun']) {
    const out = join(OUT_DIR, `smoke-${runtime}-${entry}.json`)
    try {
      const report = runtime === 'bun'
        ? run(BUN_BIN, ['--no-install', SMOKE, `--entry=${entry}`], { FMS_OUT: out })
        : run(process.execPath, [SMOKE, `--entry=${entry}`], { FMS_OUT: out })
      entries.push({ runtime, entry, ok: report.ok === true, report })
    } catch (err) {
      entries.push({ runtime, entry, ok: false, error: String(err) })
    }
  }
}

const payload = {
  capturedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  matrix,
  entries,
  ok: matrix.every((m) => m.ok) && entries.every((e) => e.ok),
}

const outFile = join(OUT_DIR, 'cross-runtime.json')
writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({ ok: payload.ok, outFile, matrixFails: matrix.filter((m) => !m.ok), entryFails: entries.filter((e) => !e.ok) }, null, 2))
if (!payload.ok) process.exitCode = 1
