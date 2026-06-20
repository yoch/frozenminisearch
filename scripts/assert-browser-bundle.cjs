#!/usr/bin/env node
const { accessSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const bundlePath = join(__dirname, '..', 'dist', 'browser', 'index.js')
const dtsPath = join(__dirname, '..', 'dist', 'browser', 'index.d.ts')
const forbiddenBundlePatterns = [
  { name: 'Node builtin imports', pattern: /\b(?:from\s*|import\s*\(|require\s*\()\s*['"]node:/ },
  { name: 'Buffer runtime usage', pattern: /\bBuffer\b/ },
  { name: 'binary format module', pattern: /binaryFormat|binaryIo|binaryMsv5|storedFieldsWire/ },
  { name: 'binary API names', pattern: /saveBinarySync|saveBinaryAsync|loadBinarySync|loadBinaryAsync/ },
]
const binaryApiNames = ['saveBinarySync', 'saveBinaryAsync', 'loadBinarySync', 'loadBinaryAsync']

try {
  accessSync(bundlePath)
  accessSync(dtsPath)
} catch {
  console.error('test:browser: missing dist/browser output — run yarn build first')
  process.exit(1)
}

const bundle = readFileSync(bundlePath, 'utf8')
const dts = readFileSync(dtsPath, 'utf8')

for (const { name, pattern } of forbiddenBundlePatterns) {
  if (pattern.test(bundle)) {
    console.error(`test:browser: forbidden ${name} found in dist/browser/index.js`)
    process.exit(1)
  }
}

for (const apiName of binaryApiNames) {
  if (dts.includes(apiName)) {
    console.error(`test:browser: forbidden binary API ${apiName} found in dist/browser/index.d.ts`)
    process.exit(1)
  }
}

async function main () {
  const mod = await import(pathToFileURL(bundlePath).href)
  const FrozenMiniSearch = mod.default
  for (const apiName of binaryApiNames) {
    if (typeof FrozenMiniSearch[apiName] !== 'undefined') {
      console.error(`test:browser: ${apiName} is exposed by the browser default export`)
      process.exit(1)
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
