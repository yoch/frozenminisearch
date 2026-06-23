#!/usr/bin/env node
/**
 * Assemble a self-contained FrozenMiniSearch browser demo under docs/demo/.
 * Requires `pnpm build` (dist/browser/index.js) beforehand.
 */
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const browserBundle = join(root, 'dist', 'browser', 'index.js')
const sourceDemo = join(root, 'examples', 'plain_js_frozen')
const corpus = join(root, 'examples', 'billboard_1965-2015.json')
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
cpSync(join(root, 'examples', 'shared.js'), join(demoDir, 'shared.js'))

const billboardDest = join(demoDir, 'billboard_1965-2015.json')
rmSync(billboardDest, { force: true })
cpSync(corpus, billboardDest)

// Self-contained paths for GitHub Pages (/demo/ has no parent examples/ tree).
writeFileSync(
  join(demoDir, 'app.js'),
  readFileSync(join(demoDir, 'app.js'), 'utf8').replace(
    "from '../shared.js'",
    "from './shared.js'",
  ),
)
writeFileSync(
  join(demoDir, 'index.html'),
  readFileSync(join(demoDir, 'index.html'), 'utf8').replace(
    "'../app.css'",
    "'app.css'",
  ),
)

console.log(`build-demo: wrote ${demoDir}`)
