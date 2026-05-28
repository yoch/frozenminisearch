import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const gc = () => { if (global.gc) global.gc() }

export const heapBytes = () => process.memoryUsage().heapUsed

export function memorySnapshot () {
  const u = process.memoryUsage()
  return {
    heapUsed: u.heapUsed,
    external: u.external,
    arrayBuffers: u.arrayBuffers,
    rss: u.rss
  }
}

export function mb (bytes) {
  return bytes / 1024 / 1024
}

export function mbRound (bytes, digits = 3) {
  return Number(mb(bytes).toFixed(digits))
}

/** Percent change from base to value (negative = improvement when lower is better). */
export function pctDelta (base, value) {
  if (base === 0) return null
  return ((value - base) / base) * 100
}

export function pctDeltaRound (base, value, digits = 1) {
  const d = pctDelta(base, value)
  return d == null ? null : Number(d.toFixed(digits))
}

export function measureHeap (fn) {
  gc()
  const before = memorySnapshot()
  const value = fn()
  gc()
  const after = memorySnapshot()
  const delta = (key) => Math.max(0, after[key] - before[key])
  const heapBytesDelta = delta('heapUsed')
  const externalBytes = delta('external')
  const arrayBuffersBytes = delta('arrayBuffers')
  const rssBytes = delta('rss')
  return {
    value,
    heapMb: mbRound(heapBytesDelta),
    heapBytes: heapBytesDelta,
    externalMb: mbRound(externalBytes),
    externalBytes,
    arrayBuffersMb: mbRound(arrayBuffersBytes),
    arrayBuffersBytes,
    rssMb: mbRound(rssBytes),
    rssBytes,
    totalResidentApproxMb: mbRound(heapBytesDelta + externalBytes),
    totalResidentApproxBytes: heapBytesDelta + externalBytes
  }
}

export function medianOf (values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function medianMeasureHeap (fn, runs = 1) {
  if (runs <= 1) return measureHeap(fn)
  const samples = []
  let lastValue
  for (let i = 0; i < runs; i++) {
    const sample = measureHeap(fn)
    lastValue = sample.value
    samples.push(sample)
  }
  const pick = (key) => medianOf(samples.map((s) => s[key]))
  return {
    value: lastValue,
    heapMb: mbRound(pick('heapBytes')),
    heapBytes: pick('heapBytes'),
    externalMb: mbRound(pick('externalBytes')),
    externalBytes: pick('externalBytes'),
    arrayBuffersMb: mbRound(pick('arrayBuffersBytes')),
    arrayBuffersBytes: pick('arrayBuffersBytes'),
    rssMb: mbRound(pick('rssBytes')),
    rssBytes: pick('rssBytes'),
    totalResidentApproxMb: mbRound(pick('totalResidentApproxBytes')),
    totalResidentApproxBytes: pick('totalResidentApproxBytes')
  }
}

export function benchSearch (index, query, searchOptions = {}, iterations = 80) {
  index.search(query, searchOptions)
  const times = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    index.search(query, searchOptions)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)]
  }
}

export function timedMs (fn) {
  const t0 = performance.now()
  const result = fn()
  return { result, ms: performance.now() - t0 }
}

function gitCommand (args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', cwd: REPO_ROOT }).trim()
  } catch {
    return null
  }
}

export function collectRunMetadata () {
  let version = null
  try {
    version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
  } catch { /* ignore */ }

  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    packageVersion: version,
    gcExposed: typeof global.gc === 'function',
    git: {
      commit: gitCommand('rev-parse HEAD'),
      commitShort: gitCommand('rev-parse --short HEAD'),
      branch: gitCommand('rev-parse --abbrev-ref HEAD'),
      dirty: gitCommand('status --porcelain') !== ''
    }
  }
}

export function parseRunsArg (args = process.argv) {
  let runs = 1
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--runs') {
      const next = Number(args[i + 1])
      if (Number.isFinite(next) && next > 0) runs = Math.floor(next)
    } else if (arg.startsWith('--runs=')) {
      const next = Number(arg.split('=')[1])
      if (Number.isFinite(next) && next > 0) runs = Math.floor(next)
    }
  }
  return runs
}
