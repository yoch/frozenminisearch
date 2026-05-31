#!/usr/bin/env node
/** Fail prepublish if npm pack would ship dev-only paths (e.g. benchmarks). */
const { execSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const forbidden = [/^benchmarks\//, /^src\//, /^examples\//]

const out = execSync('npm pack --dry-run 2>&1', {
  cwd: root,
  encoding: 'utf8',
  shell: true,
})
const paths = [...out.matchAll(/^npm notice [\d.]+(?:kB|B) (.+)$/gm)].map((m) => m[1])

if (paths.length === 0) {
  console.error('verify-npm-pack: could not parse npm pack file list')
  process.exit(1)
}

for (const p of paths) {
  if (forbidden.some((re) => re.test(p))) {
    console.error(`verify-npm-pack: forbidden path in tarball: ${p}`)
    process.exit(1)
  }
}

console.log(`verify-npm-pack: ok (${paths.length} files, no benchmarks/src)`)
