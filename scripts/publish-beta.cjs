#!/usr/bin/env node
/**
 * Publish to npm and keep dist-tags `beta` and `latest` on the same version.
 *
 * `publishConfig.tag: "beta"` only updates the beta tag on `npm publish`;
 * this script also moves `latest` so `npm install @yoch/minisearch` matches @beta.
 *
 * Usage: npm run release:beta
 * Requires: npm login + 2FA OTP when prompted.
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const name = pkg.name

function run (cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log(`Publishing ${name}@${version} (tag beta, then sync latest)…\n`)
run('npm', ['publish', '--tag', 'beta'])
run('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'])
run('npm', ['dist-tag', 'add', `${name}@${version}`, 'beta'])
console.log(`\nDone. latest and beta → ${version}`)
console.log('Verify: npm view', name, 'dist-tags')
