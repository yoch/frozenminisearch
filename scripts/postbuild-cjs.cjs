const fs = require('node:fs')
const path = require('node:path')
const { cjsWrapper } = require('./cjsWrapper.cjs')

const distDir = path.join(__dirname, '..', 'dist', 'cjs')
const entryFile = path.join(distDir, 'index.cjs')
const wrapperFile = path.join(distDir, 'index.require.cjs')

if (!fs.existsSync(entryFile)) {
  process.exit(0)
}

const wrapper = cjsWrapper('./index.cjs')

fs.writeFileSync(wrapperFile, wrapper)
