/**
 * Source of the CommonJS entry that makes `require('@yoch/frozenminisearch')` return the
 * FrozenMiniSearch class itself, with every named export attached to it. Shared by
 * dist/cjs/index.require.cjs (over the Rollup CJS bundle) and dist/aot/index.require.cjs
 * (over the typed AOT source), so `require` has the same shape under Node, Bun JIT and
 * Bun AOT.
 */
function cjsWrapper (target) {
  return `'use strict'

const mod = require('${target}')
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
}

module.exports = { cjsWrapper }
