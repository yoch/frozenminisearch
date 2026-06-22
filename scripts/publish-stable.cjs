#!/usr/bin/env node
/**
 * Publish a stable release to npm (dist-tag `latest`).
 *
 * Usage: pnpm release:stable
 * Requires: pnpm login + 2FA OTP when prompted.
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { assertPublishReady } = require('./release-checks.cjs')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const name = pkg.name

function run (cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log(`Publishing ${name}@${version} (dist-tag latest)…`)
assertPublishReady({ root, version, channel: 'stable' })
console.log('Docs deploy from tag v' + version + ' via the Docs workflow.\n')
run('pnpm', ['publish'])
console.log(`\nDone. Verify: pnpm view ${name} version dist-tags`)
