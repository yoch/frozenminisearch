#!/usr/bin/env node
/**
 * Publish a stable release to npm (dist-tag `latest`).
 *
 * Usage: npm run release:stable
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

console.log(`Publishing ${name}@${version} (dist-tag latest)…`)
console.log('Reminder: if README/API changed, run `npm run build-docs`, commit docs/ HTML, and ensure the Docs GitHub Action has run (docs/media/ is not versioned).\n')
run('npm', ['publish'])
console.log(`\nDone. Verify: npm view ${name} version dist-tags`)
