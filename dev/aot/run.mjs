#!/usr/bin/env node
/**
 * Bun AOT consumer test for the packed package (run `make build` first).
 *
 * The package is installed outside the repository: inside it, the root package.json
 * shares the package name and Bun would resolve the import to the repository itself.
 *
 * 1. A probe with a deliberate type error: Bun only prints the library's own type errors
 *    when a build reports diagnostics, so this is how they become visible.
 * 2. A consumer compiled with `bun build --compile --aot`, which must pick
 *    dist/aot/index.aot.ts and compile it with its types.
 * 3. The AOT executable and the same consumer under Bun JIT (dist/es) must produce
 *    identical results, bit for bit, through every acquisition path.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDivinaLines } from '../../benchmarks/loadDivinaLines.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const aotSource = 'dist/aot/index.aot.ts'
const untypedLibrary = /compiled without (its|their) types|index\.aot\.ts/

function fail (message, output = '') {
  if (output) process.stderr.write(`${output}\n`)
  console.error(`test-aot: ${message}`)
  process.exit(1)
}

if (!existsSync(join(root, aotSource))) fail(`missing ${aotSource}, run make build first`)

const work = mkdtempSync(join(tmpdir(), 'fms-aot-consumer-'))

function bun (args) {
  const result = spawnSync('bun', args, { cwd: work, encoding: 'utf8' })
  if (result.error) fail(`cannot run bun: ${result.error.message}`)
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function runReport (command, args) {
  const result = spawnSync(command, args, { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`, `${result.stdout}${result.stderr}`)
  return JSON.parse(result.stdout)
}

try {
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: root, encoding: 'utf8' })
  const tarball = packed.trim().split('\n').pop()
  const packageDir = join(work, 'node_modules', '@yoch', 'frozenminisearch')
  mkdirSync(packageDir, { recursive: true })
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', packageDir, '--strip-components=1'])

  writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  copyFileSync(join(here, 'consumer.ts'), join(work, 'consumer.ts'))
  writeFileSync(join(work, 'corpus.json'), JSON.stringify(loadDivinaLines().map((line, id) => ({ id, txt: line.txt }))))
  writeFileSync(
    join(work, 'probe.ts'),
    "import * as library from '@yoch/frozenminisearch'\nconst probe: number = 'not a number'\nconsole.log(library, probe)\n",
  )

  const probe = bun(['build', '--compile', '--aot', 'probe.ts', '--outfile', 'probe'])
  if (probe.status === 0 || !probe.output.includes('TS2322')) {
    fail('the probe build did not report its deliberate type error', probe.output)
  }
  if (untypedLibrary.test(probe.output)) fail(`Bun reports type errors in ${aotSource}`, probe.output)

  const build = bun(['build', '--compile', '--aot', 'consumer.ts', '--outfile', 'consumer', '--metafile=meta.json'])
  if (build.status !== 0) fail('the AOT consumer build failed', build.output)
  if (untypedLibrary.test(build.output)) fail(`Bun compiles ${aotSource} without its types`, build.output)
  const inputs = Object.keys(JSON.parse(readFileSync(join(work, 'meta.json'), 'utf8')).inputs)
  if (!inputs.some((input) => input.endsWith(`@yoch/frozenminisearch/${aotSource}`))) {
    fail(`the AOT build did not resolve the "aot" condition; inputs: ${inputs.join(', ')}`)
  }

  const aot = runReport(join(work, 'consumer'), ['corpus.json'])
  const jit = runReport('bun', ['consumer.ts', 'corpus.json'])

  for (const [key, value] of Object.entries(aot)) {
    if (jit[key] !== value) fail(`${key} differs between the AOT executable and Bun JIT`)
    if (key !== 'storedFields' && value !== aot.search) fail(`${key} differs from fromDocuments in the AOT executable`)
  }
  if (Object.keys(jit).length !== Object.keys(aot).length) fail('the AOT executable and Bun JIT report different checks')

  const bunVersion = execFileSync('bun', ['--revision'], { encoding: 'utf8' }).trim()
  console.log(`test-aot: ok (Bun ${bunVersion}, ${Object.keys(aot).length} checks identical to Bun JIT)`)
} finally {
  if (process.env.KEEP_AOT_CONSUMER) console.log(`test-aot: kept ${work}`)
  else rmSync(work, { recursive: true, force: true })
}
