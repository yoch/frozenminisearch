#!/usr/bin/env node
/**
 * Aggregate self samples from clean Node/Bun CPU profiles by function name.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const profileRoot = join(root, 'tmp/bun-results/profiles-clean')
const summaryPath = join(profileRoot, 'profile-summary.json')
const profileSummary = JSON.parse(readFileSync(summaryPath, 'utf8'))

function analyzeProfile (path) {
  const profile = JSON.parse(readFileSync(path, 'utf8'))
  const functions = new Map()
  let totalSamples = 0
  for (const node of profile.nodes ?? []) {
    const samples = node.hitCount ?? 0
    if (samples === 0) continue
    const frame = node.callFrame ?? {}
    const functionName = frame.functionName || '(anonymous)'
    const source = frame.url ? basename(frame.url) : ''
    const key = `${functionName}::${source}`
    const current = functions.get(key) ?? {
      functionName,
      source,
      samples: 0,
    }
    current.samples += samples
    functions.set(key, current)
    totalSamples += samples
  }
  const top = [...functions.values()]
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 20)
    .map(row => ({
      ...row,
      selfPercent: Number((row.samples * 100 / totalSamples).toFixed(2)),
    }))
  const explicitGcSamples = [...functions.values()]
    .filter(row => row.functionName === 'gc')
    .reduce((sum, row) => sum + row.samples, 0)
  return {
    totalSamples,
    explicitGcPercent: Number((explicitGcSamples * 100 / totalSamples).toFixed(2)),
    top,
  }
}

const analysis = []
for (const row of profileSummary.summary) {
  const profilePath = row.profileFiles.find(path => path.endsWith('.cpuprofile'))
  if (profilePath == null) continue
  analysis.push({
    caseKey: row.caseKey,
    runtime: row.runtime,
    loop: row.report,
    profilePath,
    ...analyzeProfile(profilePath),
  })
}

const out = join(profileRoot, 'profile-analysis.json')
writeFileSync(out, `${JSON.stringify({
  capturedAt: new Date().toISOString(),
  source: summaryPath,
  analysis,
}, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, out, profiles: analysis.length }, null, 2))
