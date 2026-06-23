/** Default heap benchmark scenario allowlist (editable; no runtime time cap). */
import { argValue } from '../benchmarkUtils.js'

export const DEFAULT_HEAP_SCENARIO_IDS = [
  'divina-storeFields',
  'divina-indexOnly',
  'extreme-giantVocabulary',
  'extreme-largeDocuments',
  'extreme-manyFields',
  'extreme-highFrequency',
  'extreme-overflowFrequency',
  'denseNumericIds-100k',
  'genericStringIds-100k',
  'sparseFields-50kTerms-20Fields',
  'docIdUint16Boundary-65535',
  'docIdUint16Boundary-65536',
]

export const DEFAULT_HEAP_PATHS = [
  'mutable-addAll',
  'frozen-fromDocuments',
]

export const HEAP_PATHS_FULL = [
  'mutable-addAll',
  'frozen-fromDocuments',
  'frozen-fromMiniSearch',
  'loadJSON',
  'fromJson',
]

export function parseHeapScenarioIds (args = process.argv) {
  const fromEnv = process.env.BENCH_HEAP_SCENARIOS
  const raw = argValue('--heap-scenarios', args) ?? fromEnv
  if (!raw) return [...DEFAULT_HEAP_SCENARIO_IDS]
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export function parseHeapPaths (args = process.argv) {
  const fromEnv = process.env.BENCH_HEAP_PATHS
  const raw = argValue('--heap-paths', args) ?? fromEnv
  if (!raw) return [...DEFAULT_HEAP_PATHS]
  if (raw === 'full') return [...HEAP_PATHS_FULL]
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}
