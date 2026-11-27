#!/usr/bin/env node
/**
 * Fail prepublish if pnpm pack would ship dev-only paths (e.g. benchmarks). */
const { execSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const forbidden = [/^benchmarks\//, /^testSupport\//, /^src\//, /^examples\//, /^dev\//, /^vendor\//]

function parsePackPaths (out) {
  const npmNotice = [...out.matchAll(/^npm notice [\d.]+(?:kB|B) (.+)$/gm)].map((m) => m[1])
  if (npmNotice.length > 0) return npmNotice

  const marker = 'Tarball Contents'
  const contentsIdx = out.indexOf(marker)
  if (contentsIdx === -1) return []

  const afterContents = out.slice(contentsIdx + marker.length)
  const detailsIdx = afterContents.indexOf('Tarball Details')
  const block = detailsIdx === -1 ? afterContents : afterContents.slice(0, detailsIdx)

  return block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const out = execSync('pnpm pack --dry-run 2>&1', {
  cwd: root,
  encoding: 'utf8',
  shell: true,
})
const paths = parsePackPaths(out)

if (paths.length === 0) {
  console.error(`verify-npm-pack: could not parse pnpm pack file list`)
  process.exit(1)
}

for (const p of paths) {
  if (forbidden.some((re) => re.test(p))) {
    console.error(`verify-npm-pack: forbidden path in tarball: ${p}`)
    process.exit(1)
  }
}

const { exports: packageExports } = require(join(root, 'package.json'))
function exportTargets (conditions) {
  if (typeof conditions === 'string') return [conditions]
  return Object.values(conditions).flatMap(exportTargets)
}

for (const [subpath, conditions] of Object.entries(packageExports)) {
  for (const target of exportTargets(conditions)) {
    if (!paths.includes(target.replace(/^\.\//, ''))) {
      console.error(`verify-npm-pack: export ${subpath} points to ${target}, which is not in the tarball`)
      process.exit(1)
    }
  }
}

// Resolvers take the first matching condition, and import/require/default all match.
if (Object.keys(packageExports['.'])[0] !== 'aot') {
  console.error('verify-npm-pack: "aot" must be the first condition of the "." export')
  process.exit(1)
}

// "aot" holds its own require/default pair: require must keep the class-shaped entry.
const aot = packageExports['.'].aot
if (typeof aot !== 'object' || Object.keys(aot).join() !== 'require,default' ||
    aot.require !== './dist/aot/index.require.cjs') {
  console.error('verify-npm-pack: "aot" must be { "require": "./dist/aot/index.require.cjs", "default": <typed source> }')
  process.exit(1)
}

// The "aot" target must be the generated typed source, not a stub or a hand edit.
const aotHeader = readFileSync(join(root, aot.default), 'utf8').split('\n', 1)[0]
if (!/^\/\/ Generated from src\/index\.ts by `bun compile --library` \(Bun \d+\.\d+\.\d+[^)]*\)\. Do not edit\.$/.test(aotHeader)) {
  console.error(`verify-npm-pack: ${aot.default} does not start with the build-aot-source header`)
  process.exit(1)
}

console.log(`verify-npm-pack: ok (${paths.length} files, no dev-only paths, export targets present)`)
