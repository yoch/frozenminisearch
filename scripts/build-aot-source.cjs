#!/usr/bin/env node
/**
 * Emit dist/aot/index.aot.ts, the typed single-file source behind the "aot" export
 * condition. `bun build --compile --aot` selects that condition by itself, so Bun AOT
 * consumers compile the library with its types; every other consumer keeps dist/es and
 * dist/cjs. Only index.aot.ts is kept from `bun compile --library`: its index.js, .d.ts
 * files and package.json duplicate what Rollup and the root package.json already ship.
 */
const { execFileSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const root = join(__dirname, '..')
const outFile = join(root, 'dist', 'aot', 'index.aot.ts')
const libraryDir = mkdtempSync(join(tmpdir(), 'fms-aot-library-'))

try {
  const bunVersion = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()
  try {
    execFileSync('bun', ['compile', '--no-script', '--library', 'src/index.ts', '--outdir', libraryDir], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}`)
    console.error('build-aot-source: bun compile --library failed')
    process.exit(1)
  }
  const source = readFileSync(join(libraryDir, 'index.aot.ts'), 'utf8')
  mkdirSync(join(root, 'dist', 'aot'), { recursive: true })
  writeFileSync(outFile, `// Generated from src/index.ts by \`bun compile --library\` (Bun ${bunVersion}). Do not edit.\n${source}`)
  console.log(`build-aot-source: dist/aot/index.aot.ts (${(source.length / 1024).toFixed(0)} KB, Bun ${bunVersion})`)
} finally {
  rmSync(libraryDir, { recursive: true, force: true })
}
