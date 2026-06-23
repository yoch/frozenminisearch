import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../dist/es/index.js'
import { measureRetainedHeap, aggregateHeapSamples } from '../benchmarkUtils.js'

/**
 * Build a one-shot factory for retained-heap measurement.
 * @param {string} kind
 * @param {{ corpus: unknown[], options: object }} scenario
 * @param {{ json?: string, binaryBuf?: Buffer }} [artifacts]
 */
export function heapFactoryForKind (kind, scenario, artifacts = {}) {
  const { corpus, options } = scenario
  switch (kind) {
    case 'mutable-addAll':
      return () => {
        const ms = new MiniSearch(options)
        ms.addAll(corpus)
        return ms
      }
    case 'frozen-fromDocuments':
      return () => FrozenMiniSearch.fromDocuments(corpus, options)
    case 'frozen-fromMiniSearch':
      return () => {
        const ms = new MiniSearch(options)
        ms.addAll(corpus)
        return FrozenMiniSearch._fromMiniSearch(ms, options)
      }
    case 'loadJSON':
      if (artifacts.json == null) throw new Error('loadJSON heap path requires json artifact')
      return () => MiniSearch.loadJSON(artifacts.json, options)
    case 'fromJson':
      if (artifacts.json == null) throw new Error('fromJson heap path requires json artifact')
      return () => FrozenMiniSearch.fromJson(artifacts.json, options)
    case 'loadBinary':
      if (artifacts.binaryBuf == null) throw new Error('loadBinary heap path requires binaryBuf artifact')
      return () => FrozenMiniSearch.loadBinarySync(artifacts.binaryBuf, options)
    default:
      throw new Error(`Unknown heap path kind: ${kind}`)
  }
}

export function warmupHeapFactory (factory, warmup) {
  for (let i = 0; i < warmup; i++) factory()
}

const LOAD_PATH_KINDS = new Set(['loadJSON', 'fromJson', 'loadBinary'])

export function pathNeedsArtifacts (kind) {
  return LOAD_PATH_KINDS.has(kind)
}

/** Warm up once, then median+MAD over in-process retained-heap trials. */
export function measureHeapPathInProcess (kind, scenario, {
  trials,
  gcPasses,
  warmup,
  artifacts = {},
}) {
  const factory = heapFactoryForKind(kind, scenario, artifacts)
  warmupHeapFactory(factory, warmup)
  const samples = []
  let lastValue
  for (let t = 0; t < trials; t++) {
    const sample = measureRetainedHeap(factory, { gcPasses })
    lastValue = sample.value
    samples.push(sample)
  }
  return { value: lastValue, ...aggregateHeapSamples(samples) }
}

export function buildLoadArtifacts (scenario) {
  const ms = new MiniSearch(scenario.options)
  ms.addAll(scenario.corpus)
  const json = JSON.stringify(ms.toJSON())
  const frozen = FrozenMiniSearch._fromMiniSearch(ms, scenario.options)
  return { json, binaryBuf: frozen.saveBinarySync() }
}
