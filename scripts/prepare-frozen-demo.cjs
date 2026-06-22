#!/usr/bin/env node
/**
 * Copy browser bundle into examples/plain_js_frozen/ for local HTTP serving.
 * Requires `pnpm build` first. Corpus JSON is versioned in that directory.
 */
const { cpSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const target = join(root, 'examples', 'plain_js_frozen')
const browserBundle = join(root, 'dist', 'browser', 'index.js')

if (!existsSync(browserBundle)) {
  console.error('prepare-frozen-demo: run pnpm build first')
  process.exit(1)
}

cpSync(browserBundle, join(target, 'frozenminisearch.js'))
console.log('prepare-frozen-demo: copied frozenminisearch.js into examples/plain_js_frozen/')
