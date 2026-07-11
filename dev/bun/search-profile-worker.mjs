#!/usr/bin/env node
/**
 * Dedicated public-search hot loop for CPU profiling.
 *
 * Setup and warmup happen once; the timed loop performs only search calls and
 * never invokes explicit GC. A long loop makes setup negligible in the profile.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { caseByKey } from './search-cases.mjs'

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find(arg => arg.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

const caseKey = argValue('case')
const productRoot = resolve(argValue('product-root') || resolve(import.meta.dirname, '../..'))
const durationMs = Number(argValue('duration-ms') || 8000)
const warmupCalls = Number(argValue('warmup-calls') || 500)
if (caseKey == null) throw new Error('Missing --case=<key>')

const caze = caseByKey(caseKey)
if (caze == null) throw new Error(`Unknown case: ${caseKey}`)
const require = createRequire(import.meta.url)
const productModule = require(resolve(productRoot, 'dist/cjs/index.cjs'))
const FrozenMiniSearch = productModule.default ?? productModule.FrozenMiniSearch ?? productModule
const frozen = caze.kind === 'medicaments'
  ? FrozenMiniSearch.loadBinarySync(readFileSync(caze.file), {})
  : FrozenMiniSearch.fromDocuments(caze.corpus, caze.options)
const search = () => frozen.search(caze.query, caze.opts)

let sink = 0
for (let i = 0; i < warmupCalls; i++) sink += search().length

const started = performance.now()
let calls = 0
while (performance.now() - started < durationMs) {
  for (let i = 0; i < 32; i++) {
    sink += search().length
    calls++
  }
}
const elapsedMs = performance.now() - started
const isBun = typeof globalThis.Bun !== 'undefined'
console.log(JSON.stringify({
  ok: true,
  runtime: isBun ? 'bun' : 'node',
  runtimeVersion: isBun ? Bun.version : process.version,
  caseKey,
  productRoot,
  calls,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  perCallMs: Number((elapsedMs / calls).toFixed(6)),
  sink,
}))
