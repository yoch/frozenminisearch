const fs = require('node:fs')
const path = require('node:path')

const distDir = path.join(__dirname, '..', 'dist', 'cjs')

for (const baseName of ['index', 'vectors', 'vectorsTrain']) {
  const entryFile = path.join(distDir, `${baseName}.cjs`)
  const wrapperFile = path.join(distDir, `${baseName}.require.cjs`)
  if (!fs.existsSync(entryFile)) continue

  const wrapper = baseName === 'index'
    ? `'use strict'

const mod = require('./index.cjs')
const main = mod.default || mod

module.exports = main
module.exports.default = main
module.exports.FrozenMiniSearch = main

for (const key of Object.keys(mod)) {
  if (key !== 'default') {
    module.exports[key] = mod[key]
  }
}
`
    : `'use strict'

const mod = require('./${baseName}.cjs')
module.exports = mod
`
  fs.writeFileSync(wrapperFile, wrapper)
}
