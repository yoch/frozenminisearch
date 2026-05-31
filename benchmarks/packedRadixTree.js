import Benchmark from 'benchmark'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SearchableMap from '../src/SearchableMap/SearchableMap.js'
import { fromRadixTree } from '../src/PackedRadixTree/index.js'
import { corpora } from './packedRadixCorpora.js'
import {
  appendPackedRadixHistory,
  argValue,
  assertCleanTrackedTree,
  collectRunMetadata,
  enrichGitForBaseline,
  medianMeasureHeap,
} from './benchmarkUtils.js'

/** CPU smoke only — structured bytes remain the primary metric. */
const BENCH_OPTS = { minSamples: 12, minTime: 0.15 }
const HEAP_RUNS = 3

export function measureStructuredBytes (tree) {
  const nodeBytes = (
    tree.nodeFirstEdge.byteLength
    + tree.nodeEdgeCount.byteLength
    + tree.nodeValue.byteLength
    + tree.nodeLeafOrder.byteLength
  )
  const edgeBytes = (
    tree.edgeLabelStart.byteLength
    + tree.edgeLabelLength.byteLength
    + tree.edgeChild.byteLength
  )
  const labelBytesUtf16Estimate = tree.labelHeap.length * 2

  return {
    nodeBytes,
    edgeBytes,
    labelBytesUtf16Estimate,
    labelCodeUnits: tree.labelHeap.length,
    totalStructuredBytes: nodeBytes + edgeBytes + labelBytesUtf16Estimate,
    packedByteLength: tree.packedByteLength(),
  }
}

function buildTree (entries) {
  const map = SearchableMap.from(entries)
  return fromRadixTree(map.radixTree, map.size)
}

/** Incremental heap after GC (--expose-gc): TypedArrays often show up in external/arrayBuffers. */
function measureRuntimeHeap (entries) {
  const sample = medianMeasureHeap(() => buildTree(entries), HEAP_RUNS)
  return {
    tree: sample.value,
    runtime: {
      runs: HEAP_RUNS,
      heapBytes: sample.heapBytes,
      externalBytes: sample.externalBytes,
      arrayBuffersBytes: sample.arrayBuffersBytes,
      rssBytes: sample.rssBytes,
      totalResidentApproxBytes: sample.totalResidentApproxBytes,
    },
  }
}

function runCpuSmoke (tree, probes) {
  const suite = new Benchmark.Suite('cpu-smoke')
  suite
    .add('get(hit)', () => { tree.get(probes.getHit) }, BENCH_OPTS)
    .add('get(miss)', () => { tree.get(probes.getMiss) }, BENCH_OPTS)
    .add('prefix(short)', () => { Array.from(tree.prefixEntries(probes.prefixShort)) }, BENCH_OPTS)

  return new Promise((resolve) => {
    suite.on('complete', function onComplete () {
      const timings = {}
      this.forEach((bench) => {
        timings[bench.name] = { hz: bench.hz, meanMs: bench.stats.mean * 1000 }
      })
      resolve(timings)
    })
    suite.run()
  })
}

async function runCorpus (corpus) {
  const { tree, runtime } = measureRuntimeHeap(corpus.entries)
  const bytes = measureStructuredBytes(tree)
  const timings = corpus.benchCpu ? await runCpuSmoke(tree, corpus.probes) : null

  console.log(
    `${corpus.id}: terms=${tree.size} nodes=${tree.nodeCount} edges=${tree.edgeCount}`
    + ` structured=${bytes.totalStructuredBytes}B`
    + ` runtime≈${runtime.totalResidentApproxBytes}B`
    + ` (heap=${runtime.heapBytes} ext=${runtime.externalBytes} ab=${runtime.arrayBuffersBytes})`,
  )
  if (timings != null) {
    for (const [name, t] of Object.entries(timings)) {
      console.log(`  ${name}: ${t.hz.toFixed(0)} ops/s`)
    }
  }

  return {
    size: tree.size,
    nodeCount: tree.nodeCount,
    edgeCount: tree.edgeCount,
    bytes,
    runtime,
    timings,
    ...(corpus.meta != null ? { meta: corpus.meta } : {}),
  }
}

async function main () {
  const recordPath = argValue('--record')
  const payload = { metadata: collectRunMetadata(), corpora: {} }

  const gcNote = payload.metadata.gcExposed ? '' : ' (warn: run with --expose-gc for reliable runtime heap)'
  console.log(`PackedRadixTree bench (structured bytes + runtime heap median/${HEAP_RUNS})${gcNote}`)

  for (const corpus of corpora) {
    payload.corpora[corpus.id] = await runCorpus(corpus)
  }

  if (recordPath != null) {
    const force = process.argv.includes('--force')
    assertCleanTrackedTree({ force, context: 'packed-radix baseline' })

    const git = force
      ? { ...payload.metadata.git, dirty: true }
      : enrichGitForBaseline(payload.metadata.git)

    payload.metadata = {
      ...payload.metadata,
      recordKind: force ? 'forced-dirty' : 'clean-commit',
      role: 'golden-post-phase1',
      baselineCommit: git.commit,
      git,
    }

    const benchmarksDir = join(dirname(fileURLToPath(import.meta.url)), '..')
    const out = join(benchmarksDir, recordPath)
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`\nWrote ${out}`)
    console.log(`  baselineCommit: ${git.commit}`)
    console.log(`  ${git.commitShort} — ${git.subject ?? '(no subject)'}`)

    const hist = appendPackedRadixHistory(payload, { force })
    if (hist === 'appended') {
      console.log('  historique → benchmarks/packed-radix-history.jsonl')
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
