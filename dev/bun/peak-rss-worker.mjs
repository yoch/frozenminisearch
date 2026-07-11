#!/usr/bin/env node
/**
 * Isolated peak-RSS worker. One process = one measurement.
 *
 * Workloads:
 *   --workload=build --scenario=<id>
 *   --workload=loadBinary --scenario=<id>   (builds artifact then reloads in measured window)
 *   --workload=loadBinaryFile --file=<msbin> --fields=a,b [--storeFields=...]
 *   --workload=search --scenario=<id> --query=... [--prefix] [--fuzzy=0.2]
 *
 * Prints one JSON line with OS maxRSS + sampled RSS peaks.
 */
import { readFileSync } from 'node:fs'
import MiniSearch from 'minisearch'
import FrozenMiniSearch, {
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} from '../../dist/es/index.js'
import { getScenarioById } from '../../benchmarks/scenarioRegistry.mjs'
import { gc } from '../../benchmarks/benchmarkUtils.js'

function argValue (name) {
  const flag = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(flag))
  return hit ? hit.slice(flag.length) : null
}

function runtimeInfo () {
  const isBun = typeof globalThis.Bun !== 'undefined'
  return {
    runtime: isBun ? 'bun' : 'node',
    version: isBun ? Bun.version : process.version,
    execPath: process.execPath,
    gcExposed: typeof globalThis.gc === 'function',
  }
}

function sampleRss () {
  return process.memoryUsage().rss
}

function maxRssOsKb () {
  // Linux: ru_maxrss is kilobytes
  return process.resourceUsage().maxRSS
}

function forceGc () {
  if (typeof globalThis.gc === 'function') globalThis.gc()
  else if (typeof globalThis.Bun !== 'undefined' && typeof Bun.gc === 'function') Bun.gc(true)
}

const workload = argValue('workload')
const scenarioId = argValue('scenario')
const filePath = argValue('file')
const fields = (argValue('fields') || '').split(',').filter(Boolean)
const storeFields = (argValue('storeFields') || '').split(',').filter(Boolean)
const query = argValue('query') || 'inferno'
const prefix = process.argv.includes('--prefix')
const fuzzy = argValue('fuzzy') != null ? Number(argValue('fuzzy')) : undefined

if (!workload) {
  console.error('missing --workload=')
  process.exit(2)
}

forceGc()
const rssBefore = sampleRss()
const t0 = performance.now()
let control = null
let peakSampledRss = rssBefore

const tick = () => {
  const r = sampleRss()
  if (r > peakSampledRss) peakSampledRss = r
}

if (workload === 'build') {
  const scenario = getScenarioById(scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  const builder = createFrozenIndexBuilder(scenario.options, {
    estimatedDocumentCount: scenario.corpus.length,
  })
  for (const doc of scenario.corpus) {
    builder.add(doc)
    tick()
  }
  const frozen = freezeFrozenIndexBuilder(builder)
  tick()
  control = {
    termCount: frozen.termCount,
    documentCount: frozen.documentCount,
    searchHits: frozen.search(scenario.queries[0]?.q || 'a').length,
  }
  // keep live until end
  globalThis.__keep = frozen
} else if (workload === 'loadBinary') {
  const scenario = getScenarioById(scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  // Prepare artifact outside measured peak attribution as much as possible:
  // still counted in process RSS; report both total and post-load control.
  const frozen0 = FrozenMiniSearch.fromDocuments(scenario.corpus, scenario.options)
  const buf = frozen0.saveBinarySync({ compression: 'zlib' })
  forceGc()
  const rssAfterArtifact = sampleRss()
  peakSampledRss = rssAfterArtifact
  const loaded = FrozenMiniSearch.loadBinarySync(buf, scenario.options)
  tick()
  control = {
    termCount: loaded.termCount,
    documentCount: loaded.documentCount,
    binaryBytes: buf.byteLength,
    rssAfterArtifact,
    searchHits: loaded.search(scenario.queries[0]?.q || 'a').length,
  }
  globalThis.__keep = loaded
} else if (workload === 'loadBinaryFile') {
  if (!filePath) throw new Error('missing --file=')
  // Field names are embedded in the snapshot; only pass overrides when provided.
  const options = {}
  if (fields.length) options.fields = fields
  if (storeFields.length) options.storeFields = storeFields
  const buf = readFileSync(filePath)
  forceGc()
  const rssAfterRead = sampleRss()
  peakSampledRss = Math.max(peakSampledRss, rssAfterRead)
  const loaded = FrozenMiniSearch.loadBinarySync(buf, options)
  tick()
  control = {
    termCount: loaded.termCount,
    documentCount: loaded.documentCount,
    binaryBytes: buf.byteLength,
    rssAfterRead,
    searchHits: loaded.search(query, { prefix, ...(fuzzy != null ? { fuzzy } : {}) }).length,
  }
  globalThis.__keep = loaded
} else if (workload === 'search') {
  const scenario = getScenarioById(scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  const frozen = FrozenMiniSearch.fromDocuments(scenario.corpus, scenario.options)
  forceGc()
  const rssReady = sampleRss()
  peakSampledRss = rssReady
  let hits = 0
  for (let i = 0; i < 200; i++) {
    hits = frozen.search(query, { prefix, ...(fuzzy != null ? { fuzzy } : {}) }).length
    tick()
  }
  control = { hits, rssReady, termCount: frozen.termCount, documentCount: frozen.documentCount }
  globalThis.__keep = frozen
} else if (workload === 'mutable-addAll') {
  const scenario = getScenarioById(scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  const ms = new MiniSearch(scenario.options)
  ms.addAll(scenario.corpus)
  tick()
  control = { documentCount: ms.documentCount, searchHits: ms.search(scenario.queries[0]?.q || 'a').length }
  globalThis.__keep = ms
} else {
  throw new Error(`unknown workload ${workload}`)
}

const elapsedMs = performance.now() - t0
const rssAfter = sampleRss()
const maxRssKb = maxRssOsKb()

const report = {
  ok: true,
  ...runtimeInfo(),
  workload,
  scenarioId,
  filePath,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  rssBeforeMb: Number((rssBefore / 1024 / 1024).toFixed(3)),
  rssAfterMb: Number((rssAfter / 1024 / 1024).toFixed(3)),
  peakSampledRssMb: Number((peakSampledRss / 1024 / 1024).toFixed(3)),
  maxRssOsMb: Number((maxRssKb / 1024).toFixed(3)),
  control,
}

console.log(JSON.stringify(report))
