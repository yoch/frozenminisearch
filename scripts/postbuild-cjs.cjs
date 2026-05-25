const fs = require('node:fs')
const path = require('node:path')

const distDir = path.join(__dirname, '..', 'dist', 'cjs')
const entryFile = path.join(distDir, 'index.cjs')
const wrapperFile = path.join(distDir, 'index.require.cjs')

if (!fs.existsSync(entryFile)) {
  process.exit(0)
}

const wrapper = `'use strict'

const mod = require('./index.cjs')
const main = mod.default || mod

module.exports = main
module.exports.default = main

for (const key of Object.keys(mod)) {
  if (key !== 'default') {
    module.exports[key] = mod[key]
  }
}
`

fs.writeFileSync(wrapperFile, wrapper)
