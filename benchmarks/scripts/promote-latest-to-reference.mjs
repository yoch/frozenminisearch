#!/usr/bin/env node
/**
 * Promote benchmarks/baselines/latest.json → reference.json (no re-run).
 * Enriches metadata for a golden baseline.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enrichGitForBaseline } from '../benchmarkUtils.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '../baselines')
const latestPath = join(dir, 'latest.json')
const referencePath = join(dir, 'reference.json')

const payload = JSON.parse(readFileSync(latestPath, 'utf8'))
const enriched = {
  ...payload,
  recordKind: (payload.git?.dirty || payload.git?.trackedDirty) ? 'reference-forced-dirty' : 'reference',
  git: enrichGitForBaseline(payload.git),
  baselineCommit: enrichGitForBaseline(payload.git).commit,
  promotedFrom: 'latest.json',
  promotedAt: new Date().toISOString(),
}

writeFileSync(referencePath, JSON.stringify(enriched, null, 2) + '\n')
console.log(`Promoted ${latestPath} → ${referencePath}`)
console.log(`  baselineCommit: ${enriched.baselineCommit.slice(0, 7)}`)
