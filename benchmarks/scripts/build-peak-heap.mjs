/**
 * Transient heap peak during FrozenIndexBuilder / fromDocuments (requires --expose-gc).
 *
 *   pnpm bench:build-peak
 *
 * Writes benchmarks/baselines/build-peak-heap.json for OPT-1 go/no-go (radix share of peak).
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} from '../../dist/es/index.js'
import { frozenMemoryBreakdown } from '../harness/frozenDistInternals.mjs'
import { loadDivinaLines } from '../loadDivinaLines.js'
import { highFrequencyTerms } from '../benchmarkScenarios.js'
import {
  createPeakHeapSampler,
  gc,
  mbRound,
  measureHeap,
  medianOf,
} from '../benchmarkUtils.js'
import {
  emitGcAuditMarker,
  gcAuditChildEnabled,
  gcAuditRequested,
  gcAuditRuns,
  runGcAuditScript,
} from '../gcAudit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '../baselines/build-peak-heap.json')
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const GC_AUDIT_CHILD = gcAuditChildEnabled()

function parseRuns () {
  const env = Number(process.env.RUNS)
  if (Number.isFinite(env) && env > 0) return Math.floor(env)
  return 3
}

function divinaCorpus () {
  return loadDivinaLines()
}

const SCENARIOS = [
  {
    id: 'divina-indexOnly',
    name: 'Divina Commedia — index only',
    corpus: () => divinaCorpus(),
    options: { fields: ['txt'], storeFields: [] },
  },
  {
    id: 'divina-storeFields',
    name: 'Divina Commedia — with storeFields',
    corpus: () => divinaCorpus(),
    options: { fields: ['txt'], storeFields: ['txt'] },
  },
  {
    id: 'extreme-highFrequency',
    name: 'High-frequency terms (10k docs)',
    corpus: () => highFrequencyTerms(10000),
    options: { fields: ['txt'], storeFields: [] },
  },
]

function measurePhasedBuild (corpus, options, auditMeta = null) {
  if (auditMeta != null) emitGcAuditMarker('baseline-gc-start', auditMeta)
  const sampler = createPeakHeapSampler()
  if (auditMeta != null) emitGcAuditMarker('baseline-gc-end', auditMeta)
  const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: corpus.length })

  if (auditMeta != null) emitGcAuditMarker('add-start', { ...auditMeta, measureWindow: true })
  for (const document of corpus) {
    builder.add(document)
    sampler.sample()
  }
  if (auditMeta != null) emitGcAuditMarker('add-end', { ...auditMeta, measureWindow: true })
  sampler.sample()
  const peakAfterAddMb = sampler.peakHeapMb()
  const peakAfterAddTotalResidentMb = sampler.peakTotalResidentMb()

  if (auditMeta != null) emitGcAuditMarker('freeze-start', { ...auditMeta, measureWindow: true })
  const frozen = freezeFrozenIndexBuilder(builder)
  if (auditMeta != null) emitGcAuditMarker('freeze-end', { ...auditMeta, measureWindow: true })
  sampler.sample()
  const finished = sampler.finish(frozen)
  const breakdown = frozenMemoryBreakdown(frozen)

  const postingsMb = mbRound(breakdown.postings.totalTypedBytes)
  const radixMb = mbRound(breakdown.radixTree.estimatedBytes)
  const storedMb = mbRound(breakdown.documents.storedFieldsJsonBytes)
  const structuredMb = mbRound(breakdown.estimatedStructuredBytes)
  const peakHeapMb = finished.peakHeapBytes / 1024 / 1024
  const peakTotalResidentMb = finished.peakTotalResidentBytes / 1024 / 1024

  return {
    peakHeapMb,
    peakHeapKb: Number((finished.peakHeapBytes / 1024).toFixed(1)),
    peakTotalResidentMb,
    peakTotalResidentKb: Number((finished.peakTotalResidentBytes / 1024).toFixed(1)),
    peakAfterAddMb,
    peakAfterAddTotalResidentMb,
    peakRssMb: finished.peakRssMb,
    retainedHeapMb: null,
    retainedHeapKb: null,
    peakVsRetainedRatio: null,
    breakdownMb: {
      postings: postingsMb,
      radixTree: radixMb,
      storedFieldsJson: storedMb,
      structuredTotal: structuredMb,
    },
    radixShareOfStructuredPct: structuredMb > 0
      ? Number((100 * radixMb / structuredMb).toFixed(1))
      : null,
    peakRadixShareEstimatePct: peakHeapMb > 0
      ? Number((100 * radixMb / peakHeapMb).toFixed(1))
      : null,
    termCount: frozen.termCount,
    documentCount: frozen.documentCount,
  }
}

function measureRetainedBuild (corpus, options, auditMeta = null) {
  if (auditMeta != null) emitGcAuditMarker('retained-start', auditMeta)
  const sample = measureHeap(() => {
    const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: corpus.length })
    for (const document of corpus) builder.add(document)
    return freezeFrozenIndexBuilder(builder)
  })
  if (auditMeta != null) emitGcAuditMarker('retained-end', auditMeta)
  return {
    retainedHeapMb: Number((sample.heapBytes / 1024 / 1024).toFixed(4)),
    retainedHeapKb: Number((sample.heapBytes / 1024).toFixed(1)),
  }
}

function medianScenario (runs, corpus, options, scenarioId) {
  const peakSamples = []
  const retainedSamples = []
  for (let i = 0; i < runs; i++) {
    gc()
    const auditMeta = GC_AUDIT_CHILD ? { scenarioId, run: i } : null
    peakSamples.push(measurePhasedBuild(corpus, options, auditMeta))
    gc()
    retainedSamples.push(measureRetainedBuild(corpus, options, auditMeta))
  }
  const pickPeak = (key) => medianOf(peakSamples.map((s) => s[key]))
  const retainedHeapMb = medianOf(retainedSamples.map((s) => s.retainedHeapMb))
  const peakHeapMb = pickPeak('peakHeapMb')
  const peakTotalResidentMb = pickPeak('peakTotalResidentMb')
  const first = peakSamples[0]
  return {
    peakHeapMb: Number(peakHeapMb.toFixed(4)),
    peakHeapKb: Number(medianOf(peakSamples.map((s) => s.peakHeapKb)).toFixed(1)),
    peakTotalResidentMb: Number(peakTotalResidentMb.toFixed(4)),
    peakTotalResidentKb: Number(medianOf(peakSamples.map((s) => s.peakTotalResidentKb)).toFixed(1)),
    peakAfterAddMb: Number(medianOf(peakSamples.map((s) => s.peakAfterAddMb)).toFixed(4)),
    peakAfterAddTotalResidentMb: Number(medianOf(peakSamples.map((s) => s.peakAfterAddTotalResidentMb)).toFixed(4)),
    freezeDeltaMb: Number((peakHeapMb - medianOf(peakSamples.map((s) => s.peakAfterAddMb))).toFixed(4)),
    freezeDeltaTotalResidentMb: Number((peakTotalResidentMb - medianOf(peakSamples.map((s) => s.peakAfterAddTotalResidentMb))).toFixed(4)),
    peakRssMb: Number(pickPeak('peakRssMb').toFixed(3)),
    retainedHeapMb,
    retainedHeapKb: medianOf(retainedSamples.map((s) => s.retainedHeapKb)),
    peakVsRetainedRatio: peakHeapMb > 0 && retainedHeapMb > 0
      ? Number((peakHeapMb / retainedHeapMb).toFixed(2))
      : null,
    breakdownMb: first.breakdownMb,
    radixShareOfStructuredPct: first.radixShareOfStructuredPct,
    peakRadixShareEstimatePct: Number(medianOf(peakSamples.map((s) => s.peakRadixShareEstimatePct)).toFixed(1)),
    termCount: first.termCount,
    documentCount: first.documentCount,
  }
}

function main () {
  if (typeof global.gc !== 'function') {
    console.warn('Warning: run with --expose-gc for stable peak measurements')
  }

  const runs = parseRuns()
  const gcAuditEnabled = gcAuditRequested()
  const capturedAt = new Date().toISOString()
  const scenarios = []

  for (const spec of SCENARIOS) {
    const corpus = spec.corpus()
    console.log(`\n${spec.name} (${corpus.length} docs, ${runs} run(s))`)

    const build = medianScenario(runs, corpus, spec.options, spec.id)

    console.log(`  peak heap:       ${build.peakHeapMb} MB (${build.peakHeapKb} KB)  after add: ${build.peakAfterAddMb} MB  freeze +${build.freezeDeltaMb} MB`)
    console.log(`  peak total:      ${build.peakTotalResidentMb} MB (${build.peakTotalResidentKb} KB)  after add: ${build.peakAfterAddTotalResidentMb} MB  freeze +${build.freezeDeltaTotalResidentMb} MB`)
    console.log(`  retained:        ${build.retainedHeapMb} MB (${build.retainedHeapKb} KB)  peak/retained: ${build.peakVsRetainedRatio}x`)
    console.log(`  radix ~${build.peakRadixShareEstimatePct}% of peak (structured share ${build.radixShareOfStructuredPct}%)`)

    scenarios.push({
      id: spec.id,
      name: spec.name,
      documentCount: corpus.length,
      runs,
      build,
    })
  }

  const payload = {
    capturedAt,
    node: process.version,
    gcExposed: typeof global.gc === 'function',
    runs,
    note: 'peakHeapMb is max heapUsed above post-gc baseline during build; peakTotalResidentMb is max heapUsed+external; retainedHeapMb is measureHeap delta after gc.',
    opt1Hint: 'OPT-1 targets freezeDeltaMb and radix overlap at freeze. If peakAfterAdd ≈ peak total, prioritize postings/storedFields pressure over radix pack.',
    scenarios,
  }

  if (!GC_AUDIT_CHILD && gcAuditEnabled) {
    payload.gcAudit = runGcAuditScript({
      scriptPath: SCRIPT_PATH,
      env: {
        ...process.env,
        RUNS: String(gcAuditRuns(runs)),
      },
    })
    console.log(`\nGC audit: ${payload.gcAudit.clean ? 'clean' : 'major GC observed'} (${payload.gcAudit.unexpectedMajorGcCount} unexpected major GC in measured windows)`)
  }

  if (GC_AUDIT_CHILD) return

  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`\nWrote ${OUT}`)
}

main()
