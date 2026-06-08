#!/usr/bin/env node
/**
 * Build TypeDoc site: verify (local/PR) or pages (GitHub Pages release deploy).
 *
 * Env:
 *   DOCS_PAGES=1  — basePath, hostedBaseUrl, version in header title
 *   DOCS_VERSION  — semver for --name (defaults to package.json version)
 */
const { cpSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.env.DOCS_VERSION || pkg.version
const pages = process.env.DOCS_PAGES === '1'

function run (cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const typedocBin = join(root, 'node_modules', 'typedoc', 'bin', 'typedoc')
const typedocArgs = [typedocBin, '--options', 'typedoc.json']
if (pages) {
  typedocArgs.push(
    '--basePath', '/frozenminisearch/',
    '--hostedBaseUrl', 'https://yoch.github.io/frozenminisearch/',
    '--name', `@yoch/frozenminisearch v${version}`,
  )
}

run(process.execPath, typedocArgs)
run(process.execPath, [join(root, 'scripts', 'sync-docs-media.cjs')])

const demoDir = join(root, 'docs', 'demo')
rmSync(demoDir, { recursive: true, force: true })
cpSync(join(root, 'examples', 'plain_js'), demoDir, { recursive: true, dereference: true })
