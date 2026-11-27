#!/usr/bin/env node
/**
 * Emit dist/aot/index.aot.ts, the typed single-file source behind the "aot" export
 * condition, and dist/aot/index.require.cjs, which gives `require` the same shape as
 * dist/cjs/index.require.cjs (the class, with the named exports attached). `bun build --compile --aot` selects that condition by itself, so Bun AOT
 * consumers compile the library with its types; every other consumer keeps dist/es and
 * dist/cjs. Only index.aot.ts is kept from `bun compile --library`: its index.js, .d.ts
 * files and package.json duplicate what Rollup and the root package.json already ship.
 */
const { execFileSync, spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { cjsWrapper } = require('./cjsWrapper.cjs')

const root = join(__dirname, '..')
const outFile = join(root, 'dist', 'aot', 'index.aot.ts')
const libraryDir = mkdtempSync(join(tmpdir(), 'fms-aot-library-'))

try {
  let bunVersion
  try {
    bunVersion = execFileSync('bun', ['--revision'], { encoding: 'utf8' }).trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    console.error('build-aot-source: bun not found on PATH. The build needs Bun to emit dist/aot/index.aot.ts (the "aot" export target), as make lint needs it for bun check: https://bun.com/docs/installation')
    process.exitCode = 1
    return
  }
  const compileHelp = spawnSync('bun', ['compile', '--help'], { encoding: 'utf8' })
  if (!/--library\b/.test(`${compileHelp.stdout}${compileHelp.stderr}`)) {
    console.error(`build-aot-source: Bun ${bunVersion} has no \`bun compile --library\`. Install a Bun that has --aot (a canary for now: bun upgrade --canary).`)
    process.exitCode = 1
    return
  }
  try {
    execFileSync('bun', ['compile', '--no-script', '--library', 'src/index.ts', '--outdir', libraryDir], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}`)
    console.error('build-aot-source: bun compile --library failed')
    process.exitCode = 1
    return
  }
  const source = readFileSync(join(libraryDir, 'index.aot.ts'), 'utf8')
  const contents = `// Generated from src/index.ts by \`bun compile --library\` (Bun ${bunVersion}). Do not edit.\n${source}`
  mkdirSync(join(root, 'dist', 'aot'), { recursive: true })
  writeFileSync(outFile, contents)
  writeFileSync(join(root, 'dist', 'aot', 'index.require.cjs'), cjsWrapper('./index.aot.ts'))
  console.log(`build-aot-source: dist/aot/index.aot.ts (${(Buffer.byteLength(contents) / 1024).toFixed(0)} KiB, Bun ${bunVersion}) and index.require.cjs`)
} finally {
  rmSync(libraryDir, { recursive: true, force: true })
}
