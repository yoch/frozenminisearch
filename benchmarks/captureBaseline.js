/**
 * Run the full benchmark suite and write JSON results.
 *
 *   yarn benchmark:record              → benchmarks/baselines/latest.json
 *   yarn benchmark:record --reference → benchmarks/baselines/reference.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCleanTrackedTree,
  collectRunMetadata,
  enrichGitForBaseline,
  parseBenchmarkArgs,
} from './benchmarkUtils.js'
import { runBenchmarkSuite } from './benchmarkSuite.js'
import { getSearchBenchProtocol } from './loadSearchBenchBatches.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES_DIR = join(__dirname, 'baselines')

const useReference = process.argv.includes('--reference')
const force = process.argv.includes('--force')
const outFile = join(BASELINES_DIR, useReference ? 'reference.json' : 'latest.json')
const { runs, searchIterations, benchProfile } = parseBenchmarkArgs()

if (useReference) {
  assertCleanTrackedTree({ force, context: 'MiniSearch reference.json' })
}

console.log('Running benchmark suite (requires --expose-gc for stable heap)...\n')
if (!global.gc) {
  console.warn('Warning: run with NODE_OPTIONS=--expose-gc or node --expose-gc for accurate heap.\n')
}

const meta = collectRunMetadata()
const payload = {
  ...meta,
  recordKind: useReference
    ? (force ? 'forced-dirty' : 'clean-commit')
    : 'local-latest',
  runs,
  searchIterations,
  benchProfile,
  searchBenchProtocol: getSearchBenchProtocol(),
  scenarios: runBenchmarkSuite(undefined, runs, searchIterations, { benchProfile }),
}

if (useReference && !force) {
  payload.git = enrichGitForBaseline(meta.git)
  payload.baselineCommit = payload.git.commit
}

mkdirSync(BASELINES_DIR, { recursive: true })
writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n')

console.log(`Wrote ${outFile}`)
console.log(`  commit: ${payload.git.commitShort}${payload.git.dirty ? ' (dirty)' : ''}`)
if (useReference) {
  console.log(`  baselineCommit: ${payload.baselineCommit ?? payload.git.commit}`)
}
if (payload.git.dirty && !useReference) {
  console.warn('  warning: working tree is dirty; latest.json may be harder to reproduce')
}
console.log(`  profile: ${payload.benchProfile}`)
console.log(`  runs: ${runs}, search iterations: ${searchIterations} (median per scenario)`)
console.log(`  scenarios: ${payload.scenarios.length}`)
for (const s of payload.scenarios) {
  if (s.benchProfile === 'search') {
    const gain = s.summary?.searchFrozenP50AvgGainPct
    console.log(`  - ${s.id}: search-only (avg frozen p50 gain ${gain}%)`)
  } else {
    console.log(`  - ${s.id}: frozen heap ${s.heapMb.frozen} MB (${s.heapMb.frozenVsMutableSavingPct}% vs mutable)`)
  }
}
