import FrozenMiniSearch from '../../dist/es/index.js'
import { frozenMemoryBreakdown } from '../harness/frozenDistInternals.mjs'
import { getScenarioById } from '../scenarioRegistry.mjs'
import {
  defaultHeapGcPasses,
  defaultHeapTrials,
  defaultHeapWarmup,
} from '../benchmarkUtils.js'
import { HEAP_BENCH_PROTOCOL_VERSION } from '../benchStats.js'
import { parseHeapPaths } from './heapScenarios.mjs'
import {
  buildLoadArtifacts,
  measureHeapPathInProcess,
  pathNeedsArtifacts,
} from './heapMeasureCore.mjs'

function parseArg (name) {
  const flag = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(flag))
  return arg ? arg.slice(flag.length) : null
}

export function runHeapScenario (scenarioId, opts = {}) {
  const scenario = getScenarioById(scenarioId)
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`)

  const trials = Number(opts.trials ?? parseArg('heap-trials')) || defaultHeapTrials({ reference: opts.reference })
  const gcPasses = Number(opts.gcPasses ?? parseArg('heap-gc-passes')) || defaultHeapGcPasses()
  const warmup = Number(opts.warmup) || defaultHeapWarmup(scenario.corpus.length)
  const paths = opts.paths ?? parseHeapPaths()
  const needsArtifacts = paths.some(pathNeedsArtifacts)
  const artifacts = needsArtifacts ? buildLoadArtifacts(scenario) : {}

  const pathResults = {}
  for (const kind of paths) {
    pathResults[kind] = measureHeapPathInProcess(kind, scenario, {
      trials,
      gcPasses,
      warmup,
      artifacts,
    })
  }

  const mutable = pathResults['mutable-addAll']
  const frozen = pathResults['frozen-fromDocuments'] ?? pathResults['frozen-fromMiniSearch']
  if (!mutable || !frozen) {
    throw new Error(`heap scenario ${scenarioId}: requires mutable-addAll and a frozen path`)
  }

  const frozenIndex = FrozenMiniSearch.fromDocuments(scenario.corpus, scenario.options)
  const breakdown = frozenMemoryBreakdown(frozenIndex)

  const heapOnlySavingPct = mutable.heapMb > 0
    ? Number((100 * (1 - frozen.heapMb / mutable.heapMb)).toFixed(1))
    : 0
  const savingPct = mutable.totalResidentApproxMb > 0
    ? Number((100 * (1 - frozen.totalResidentApproxMb / mutable.totalResidentApproxMb)).toFixed(1))
    : 0

  return {
    scenarioId,
    documentCount: scenario.corpus.length,
    heapMb: {
      mutable: mutable.heapMb,
      frozen: frozen.heapMb,
      mutableTotalResident: mutable.totalResidentApproxMb,
      frozenTotalResident: frozen.totalResidentApproxMb,
      frozenVsMutableSavingPct: savingPct,
      frozenVsMutableHeapOnlySavingPct: heapOnlySavingPct,
      protocol: {
        version: HEAP_BENCH_PROTOCOL_VERSION,
        trials,
        gcPasses,
        isolated: 'per-scenario',
        inProcessTrials: true,
        warmup,
        paths,
      },
      ...(pathResults['loadJSON'] ? { loadJson: pathResults['loadJSON'].heapMb } : {}),
      ...(pathResults['fromJson'] ? { fromJson: pathResults['fromJson'].heapMb } : {}),
      ...(pathResults['loadBinary'] ? { loadBinary: pathResults['loadBinary'].heapMb } : {}),
    },
    heapSkipped: null,
    heapStability: {
      mutableMadMb: mutable.heapMadMb,
      frozenMadMb: frozen.heapMadMb,
      mutableTotalResidentMadMb: mutable.totalResidentMadMb,
      frozenTotalResidentMadMb: frozen.totalResidentMadMb,
    },
    memoryMb: {
      mutable: {
        heapUsed: mutable.heapMb,
        external: mutable.externalMb,
        arrayBuffers: mutable.arrayBuffersMb,
        rss: mutable.rssMb,
        totalResidentApprox: mutable.totalResidentApproxMb,
      },
      frozen: {
        heapUsed: frozen.heapMb,
        external: frozen.externalMb,
        arrayBuffers: frozen.arrayBuffersMb,
        rss: frozen.rssMb,
        totalResidentApprox: frozen.totalResidentApproxMb,
      },
    },
    memoryBreakdown: breakdown,
  }
}

const scenarioId = parseArg('scenario') ?? process.argv[2]
const reference = process.argv.includes('--reference')

if (scenarioId) {
  try {
    const result = runHeapScenario(scenarioId, { reference })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}
