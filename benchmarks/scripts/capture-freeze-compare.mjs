/**
 * Capture migrate timings (toJSONMs + freezeMs) for regression scenarios at the current commit.
 *
 *   NODE_OPTIONS='--expose-gc --import tsx/esm' node benchmarks/scripts/capture-freeze-compare.mjs --runs=7
 */
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { runScenario, buildScenarioList } from '../benchmarkSuite.js'
import { medianOf } from '../benchmarkUtils.js'

const IDS = [
  'extreme-overflowFrequency',
  'extreme-highFrequency',
  'denseNumericIds-100k',
  'docIdUint16Boundary-65536',
  'extreme-giantVocabulary',
]

const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 7)
const outPath = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]

function gitShort() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return '?'
  }
}

const scenarios = buildScenarioList().filter((s) => IDS.includes(s.id))
const payload = {
  commit: gitShort(),
  capturedAt: new Date().toISOString(),
  runs,
  scenarios: scenarios.map((sc) => {
    const toJSONSamples = []
    const freezeSamples = []
    for (let i = 0; i < runs; i++) {
      const r = runScenario(sc, { surfaces: ['migrate'] })
      toJSONSamples.push(r.indexing.toJSONMs)
      freezeSamples.push(r.indexing.freezeMs)
    }
    return {
      id: sc.id,
      toJSONMs: Number(medianOf(toJSONSamples).toFixed(2)),
      freezeMs: Number(medianOf(freezeSamples).toFixed(2)),
      toJSONSamples,
      freezeSamples,
    }
  }),
}

const json = JSON.stringify(payload, null, 2) + '\n'
if (outPath) writeFileSync(outPath, json)
console.log(json)
