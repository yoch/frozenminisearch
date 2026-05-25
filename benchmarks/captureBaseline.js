/**
 * Run the full benchmark suite and write JSON results.
 *
 *   yarn benchmark:record              → benchmarks/baselines/latest.json
 *   yarn benchmark:record --reference → benchmarks/baselines/reference.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectRunMetadata, parseRunsArg } from './benchmarkUtils.js'
import { runBenchmarkSuite } from './benchmarkSuite.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES_DIR = join(__dirname, 'baselines')

const useReference = process.argv.includes('--reference')
const outFile = join(BASELINES_DIR, useReference ? 'reference.json' : 'latest.json')
const runs = parseRunsArg()

console.log('Running benchmark suite (requires --expose-gc for stable heap)...\n')
if (!global.gc) {
  console.warn('Warning: run with NODE_OPTIONS=--expose-gc or node --expose-gc for accurate heap.\n')
}

const payload = {
  ...collectRunMetadata(),
  runs,
  scenarios: runBenchmarkSuite(undefined, runs)
}

mkdirSync(BASELINES_DIR, { recursive: true })
writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n')

console.log(`Wrote ${outFile}`)
console.log(`  commit: ${payload.git.commitShort}${payload.git.dirty ? ' (dirty)' : ''}`)
if (payload.git.dirty) {
  console.warn('  warning: working tree is dirty; baseline may be harder to reproduce')
}
if (runs > 1) {
  console.log(`  runs: ${runs} (median aggregation)`)
}
console.log(`  scenarios: ${payload.scenarios.length}`)
for (const s of payload.scenarios) {
  console.log(`  - ${s.id}: frozen heap ${s.heapMb.frozen} MB (${s.heapMb.frozenVsMutableSavingPct}% vs mutable)`)
}
