#!/usr/bin/env node
/**
 * Publish a pre-release to npm with dist-tag `beta` (does not move `latest`).
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

console.log(`Publishing ${name}@${version} (dist-tag beta)…`)
console.log('Reminder: if README/API changed, run `npm run build-docs` and commit docs/ before this step.\n')
run('npm', ['publish', '--tag', 'beta'])
console.log(`\nDone. beta → ${version} (latest unchanged)`)
console.log('Verify: npm view', name, 'dist-tags')
