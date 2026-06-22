#!/usr/bin/env node
/**
 * Assemble a self-contained FrozenMiniSearch browser demo under docs/demo/.
 * Requires `pnpm build` (dist/browser/index.js) beforehand.
 */
const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const browserBundle = join(root, 'dist', 'browser', 'index.js')
const sourceDemo = join(root, 'examples', 'plain_js_frozen')
const corpus = join(root, 'examples', 'plain_js', 'billboard_1965-2015.json')
const demoDir = join(root, 'docs', 'demo')

if (!existsSync(browserBundle)) {
  console.error('build-demo: run pnpm build first (missing dist/browser/index.js)')
  process.exit(1)
}
if (!existsSync(corpus)) {
  console.error(`build-demo: missing corpus ${corpus}`)
  process.exit(1)
}

rmSync(demoDir, { recursive: true, force: true })
mkdirSync(demoDir, { recursive: true })
cpSync(sourceDemo, demoDir, { recursive: true, dereference: true })
cpSync(browserBundle, join(demoDir, 'frozenminisearch.js'))
cpSync(join(root, 'examples', 'app.css'), join(demoDir, 'app.css'))

console.log(`build-demo: wrote ${demoDir}`)
