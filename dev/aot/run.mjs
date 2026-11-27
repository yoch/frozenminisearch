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
 * 4. The same for an untyped CommonJS consumer (`require`), shaped like
 *    fr.gouv.medicaments.rest.
 * 5. Builds without --aot (`--compile --no-aot`, plain `bun build`) must keep resolving
 *    dist/es and dist/cjs: the "aot" condition must not reach Bun JIT.
 *
 * On a Bun without `--aot` (stable releases before it), only steps 1-4 that compile with
 * --aot are skipped, with a warning: the JIT resolution checks (5) still run, and the
 * consumers compiled with plain --compile must match Bun JIT. REQUIRE_AOT=1 (set by
 * prepublish-only) turns that case into a failure.
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
// The probe build fails on purpose: any mention of the AOT source there is a type error in it.
const untypedInProbe = /compiled without (its|their) types|index\.aot\.ts/
// Successful builds may name the resolved file; a diagnostic located in it is the signal.
const untypedInBuild = /compiled without (its|their) types|index\.aot\.ts:\d+:\d+/

class TestFailure extends Error {}

function fail (message, output = '') {
  if (output) process.stderr.write(`${output}\n`)
  throw new TestFailure(`test-aot: ${message}`)
}

function exitOnFailure (error) {
  if (!(error instanceof TestFailure)) throw error
  console.error(error.message)
  process.exitCode = 1
}

function preflight () {
  if (!existsSync(join(root, aotSource))) fail(`missing ${aotSource}, run make build first`)
  const buildHelp = spawnSync('bun', ['build', '--help'], { encoding: 'utf8' })
  if (buildHelp.error) fail(`cannot run bun: ${buildHelp.error.message}`)
  if (/^\s*--aot(?![\w-])/m.test(buildHelp.stdout)) return true
  const revision = execFileSync('bun', ['--revision'], { encoding: 'utf8' }).trim()
  if (process.env.REQUIRE_AOT === '1') fail(`Bun ${revision} has no --aot, and REQUIRE_AOT=1`)
  const message = `test-aot: Bun ${revision} has no --aot; AOT builds skipped, JIT resolution still checked`
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : message)
  return false
}

let hasAot
try {
  hasAot = preflight()
} catch (error) {
  exitOnFailure(error)
  process.exit()
}
// Explicit --no-aot where it exists, in case a later Bun makes AOT the --compile default.
const jitCompile = hasAot ? ['--compile', '--no-aot'] : ['--compile']

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

function packageInputs (args) {
  const meta = join(work, 'meta.json')
  rmSync(meta, { force: true })
  const result = bun([...args, '--metafile=meta.json'])
  if (result.status !== 0) fail(`bun ${args.join(' ')} failed`, result.output)
  const inputs = Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs)
  return { output: result.output, inputs: inputs.filter((input) => input.includes('@yoch/frozenminisearch/')) }
}

function expectInputs (args, expected) {
  const { output, inputs } = packageInputs(args)
  if (inputs.length === 0 || inputs.some((input) => !expected.some((path) => input.endsWith(`@yoch/frozenminisearch/${path}`)))) {
    fail(`bun ${args.join(' ')} resolved ${inputs.join(', ') || 'nothing'}, expected ${expected.join(' or ')}`)
  }
  return output
}

function compareReports (label, compiled, jit, sameAcrossPaths) {
  for (const [key, value] of Object.entries(compiled)) {
    if (jit[key] !== value) fail(`${label}: ${key} differs between the executable and Bun JIT`)
    if (sameAcrossPaths(key) && value !== Object.values(compiled)[0]) fail(`${label}: ${key} differs from the first path in the executable`)
  }
  if (Object.keys(jit).length !== Object.keys(compiled).length) fail(`${label}: the executable and Bun JIT report different checks`)
  return Object.keys(compiled).length
}

try {
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: root, encoding: 'utf8' })
  const tarball = packed.trim().split('\n').pop()
  const packageDir = join(work, 'node_modules', '@yoch', 'frozenminisearch')
  mkdirSync(packageDir, { recursive: true })
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', packageDir, '--strip-components=1'])

  writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  copyFileSync(join(here, 'consumer.ts'), join(work, 'consumer.ts'))
  copyFileSync(join(here, 'consumer.cjs'), join(work, 'consumer.cjs'))
  writeFileSync(join(work, 'corpus.json'), JSON.stringify(loadDivinaLines().map((line, id) => ({ id, txt: line.txt }))))
  writeFileSync(
    join(work, 'probe.ts'),
    "import * as library from '@yoch/frozenminisearch'\nconst probe: number = 'not a number'\nconsole.log(library, probe)\n",
  )

  const esm = [`${aotSource}`]
  const jsEsm = ['dist/es/index.js']
  const jsCjs = ['dist/cjs/index.require.cjs', 'dist/cjs/index.cjs']

  if (hasAot) {
    const probe = bun(['build', '--compile', '--aot', 'probe.ts', '--outfile', 'probe'])
    if (probe.status === 0 || !probe.output.includes('TS2322')) {
      fail('the probe build did not report its deliberate type error', probe.output)
    }
    if (untypedInProbe.test(probe.output)) fail(`Bun reports type errors in ${aotSource}`, probe.output)

    const build = expectInputs(['build', '--compile', '--aot', 'consumer.ts', '--outfile', 'consumer'], esm)
    if (untypedInBuild.test(build)) fail(`Bun compiles ${aotSource} without its types`, build)
    const buildCjs = expectInputs(['build', '--compile', '--aot', 'consumer.cjs', '--outfile', 'consumer-cjs'], [aotSource, 'dist/aot/index.require.cjs'])
    if (untypedInBuild.test(buildCjs)) fail(`Bun compiles ${aotSource} without its types for require()`, buildCjs)
  }

  expectInputs(['build', ...jitCompile, 'consumer.ts', '--outfile', 'consumer-jit'], jsEsm)
  expectInputs(['build', ...jitCompile, 'consumer.cjs', '--outfile', 'consumer-cjs-jit'], jsCjs)
  expectInputs(['build', '--target=bun', 'consumer.ts', '--outdir', 'bundle-esm'], jsEsm)
  expectInputs(['build', '--target=bun', 'consumer.cjs', '--outdir', 'bundle-cjs'], jsCjs)
  writeFileSync(
    join(work, 'resolve.mjs'),
    "import { createRequire } from 'node:module'\nconst name = '@yoch/frozenminisearch'\nconsole.log(JSON.stringify([import.meta.resolve(name), createRequire(import.meta.url).resolve(name)]))\n",
  )
  const [runtimeImport, runtimeRequire] = runReport('bun', ['resolve.mjs'])
  if (!runtimeImport.endsWith(jsEsm[0]) || !runtimeRequire.endsWith(jsCjs[0])) {
    fail(`Bun JIT resolved ${runtimeImport} and ${runtimeRequire}, expected dist/es and dist/cjs`)
  }
  if (hasAot) {
    // `bun --aot` (script mode) is an AOT mode too, and must select the typed source.
    const [aotImport, aotRequire] = runReport('bun', ['--aot', 'resolve.mjs'])
    if (!aotImport.endsWith(aotSource) || !aotRequire.endsWith('dist/aot/index.require.cjs')) {
      fail(`bun --aot resolved ${aotImport} and ${aotRequire}, expected ${aotSource} and dist/aot/index.require.cjs`)
    }
  }

  // With --aot, the AOT executables; without, the plain --compile ones.
  const [esmExe, cjsExe] = hasAot ? ['consumer', 'consumer-cjs'] : ['consumer-jit', 'consumer-cjs-jit']
  const checks = compareReports(
    'consumer.ts',
    runReport(join(work, esmExe), ['corpus.json']),
    runReport('bun', ['consumer.ts', 'corpus.json']),
    (key) => key !== 'storedFields',
  ) + compareReports(
    'consumer.cjs',
    runReport(join(work, cjsExe), ['corpus.json']),
    runReport('bun', ['consumer.cjs', 'corpus.json']),
    () => true,
  )

  const bunVersion = execFileSync('bun', ['--revision'], { encoding: 'utf8' }).trim()
  console.log(hasAot
    ? `test-aot: ok (Bun ${bunVersion}, ${checks} checks identical to Bun JIT, "aot" condition only under --aot)`
    : `test-aot: ok without --aot (Bun ${bunVersion}, JIT resolution checked, ${checks} checks of --compile executables identical to Bun JIT)`)
} catch (error) {
  exitOnFailure(error)
} finally {
  if (process.env.KEEP_AOT_CONSUMER) console.log(`test-aot: kept ${work}`)
  else rmSync(work, { recursive: true, force: true })
}
