/**
 * Write before/after V8 heap snapshots for manual Chrome DevTools comparison.
 *
 *   yarn build && node --expose-gc benchmarks/scripts/heap-snapshot-pair.mjs --scenario=divina-indexOnly --kind=mutable-addAll
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import { getScenarioById } from '../scenarioRegistry.mjs'
import { forceGc, argValue } from '../benchmarkUtils.js'
import { heapFactoryForKind } from '../framework/heapMeasureCore.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '../tmp')

const scenarioId = argValue('--scenario') ?? 'divina-indexOnly'
const kind = argValue('--kind') ?? 'mutable-addAll'
const scenario = getScenarioById(scenarioId)
if (!scenario) {
  console.error(`Unknown scenario: ${scenarioId}`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })
const beforePath = join(OUT_DIR, `${scenarioId}-${kind}-before.heapsnapshot`)
const afterPath = join(OUT_DIR, `${scenarioId}-${kind}-after.heapsnapshot`)

forceGc(3, { strict: true })
v8.writeHeapSnapshot(beforePath)
const factory = heapFactoryForKind(kind, scenario)
factory()
forceGc(3, { strict: true })
v8.writeHeapSnapshot(afterPath)

console.log(`Wrote:\n  ${beforePath}\n  ${afterPath}`)
console.log('Open both in Chrome DevTools → Memory → Load → Comparison view.')
