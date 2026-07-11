#!/usr/bin/env node
/**
 * Apply product-promotion guards to corrected CPU, RSS and bundle artefacts.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const results = join(root, 'tmp/bun-results')

function readJson (name) {
  return JSON.parse(readFileSync(join(results, name), 'utf8'))
}

function git (cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git -C ${cwd} ${args.join(' ')} failed:\n${result.stderr}`)
  }
  return result.stdout.trim()
}

const abNames = [
  'search-product-ab-gate-1024.json',
  'search-product-ab-gate-ratios.json',
].filter(name => existsSync(join(results, name)))
const abRuns = abNames.map(readJson)
if (abRuns.length === 0) throw new Error('No corrected product A/B artefact found')
const ab = {
  baselineRoot: abRuns[0].baselineRoot,
  treatmentRoot: abRuns[0].treatmentRoot,
  summary: abRuns.flatMap(run => run.summary),
}
const rss = readJson('search-product-rss-gate-1024.json')
const bundle = readJson('search-product-bundle-comparison.json')
const baselineCommit = git(ab.baselineRoot, ['rev-parse', 'HEAD'])
const treatmentCommit = git(ab.treatmentRoot, ['rev-parse', 'HEAD'])
const treatmentDiff = git(ab.treatmentRoot, ['diff', '--', 'src'])

const checksumFailures = ab.summary
  .filter(entry =>
    !entry.runtimes.node.checksumMatch || !entry.runtimes.bun.checksumMatch,
  )
  .map(entry => entry.caseKey)
const performanceRegressions = ab.summary
  .filter(entry =>
    entry.classification === 'reject' || entry.classification === 'trade-off',
  )
  .map(entry => ({
    caseKey: entry.caseKey,
    classification: entry.classification,
  }))
const demonstratedThresholdWins = ab.summary
  .filter(entry =>
    entry.caseKey.startsWith('gate-threshold-')
    && entry.classification === 'neutral-win',
  )
  .map(entry => entry.caseKey)
const bundleRegressions = Object.entries(bundle.deltas)
  .filter(([, delta]) => delta.percent > 1)
  .map(([file, delta]) => ({ file, ...delta }))
const rssRegressions = rss.regressionsOver3Percent
const sameCommit = baselineCommit === treatmentCommit
const isolatedTreatment = treatmentDiff.includes(
  'DEFAULT_POSTING_GATE_MIN_LENGTH = 1024',
) && !treatmentDiff.includes('FuzzyScratch')

const guards = {
  sameCommit,
  isolatedTreatment,
  checksumFailures,
  performanceRegressions,
  rssRegressions,
  bundleRegressions,
  demonstratedThresholdWins,
}
const promote = sameCommit
  && isolatedTreatment
  && checksumFailures.length === 0
  && performanceRegressions.length === 0
  && rssRegressions.length === 0
  && bundleRegressions.length === 0
  && demonstratedThresholdWins.length > 0

const payload = {
  capturedAt: new Date().toISOString(),
  candidate: 'DEFAULT_POSTING_GATE_MIN_LENGTH: 2048 -> 1024',
  baselineCommit,
  treatmentCommit,
  guards,
  decision: promote ? 'promote' : 'reject-or-inconclusive',
}
const out = join(results, 'search-product-decision.json')
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({ ok: promote, out, decision: payload.decision, guards }, null, 2))
if (!promote) process.exitCode = 1
