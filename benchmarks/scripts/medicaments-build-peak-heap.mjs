/**
 * Heap peak when rebuilding medicaments indexes from a document corpus, not loadBinary().
 *
 *   pnpm bench:medicaments-build-peak
 *   CORPUS_EXPORT_DIR=/path/to/corpus-export pnpm bench:medicaments-build-peak
 *   SOURCE=msbin pnpm bench:medicaments-build-peak   # inverse .msbin fixtures
 *
 * Writes benchmarks/baselines/medicaments-build-peak-heap.json (jsonl)
 * or medicaments-build-peak-heap-msbin.json (msbin fallback).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import FrozenMiniSearch, {
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} from '../../dist/es/index.js'
import { extractCorpusFromMsbinFile } from '../extractCorpusFromMsbin.ts'
import {
  corpusExportDirAvailable,
  DEFAULT_CORPUS_EXPORT_DIR,
  loadAllCorpusExportSpecs,
  scanCorpusExportStats,
  streamCorpusExportDocuments,
} from '../loadCorpusExport.js'
import { loadManifests, resolveFixturesDir } from '../medicamentsIndexes.js'
import {
  createPeakHeapSampler,
  gc,
  mbRound,
  measureHeap,
  medianOf,
  memorySnapshot,
} from '../benchmarkUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINES = join(__dirname, '../baselines')

function parseRuns () {
  const env = Number(process.env.RUNS)
  if (Number.isFinite(env) && env > 0) return Math.floor(env)
  return 1
}

function parseOnly () {
  const raw = process.env.ONLY
  if (!raw) return null
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

function resolveSource () {
  const env = process.env.SOURCE
  if (env === 'msbin' || env === 'jsonl') return env
  return corpusExportDirAvailable() ? 'jsonl' : 'msbin'
}

function allMsbinSpecs () {
  const fixturesDir = resolveFixturesDir()
  const manifests = loadManifests()
  const specs = []
  for (const [source, manifest] of Object.entries(manifests)) {
    for (const [manifestKey, entry] of Object.entries(manifest.indexes)) {
      specs.push({
        id: `${source}-${manifestKey}`,
        file: entry.file,
        filePath: join(fixturesDir, entry.file),
        source,
        manifestKey,
        manifest: entry,
      })
    }
  }
  specs.sort((a, b) => a.id.localeCompare(b.id))
  return specs
}

function measurePhasedBuild (corpus, options) {
  const sampler = createPeakHeapSampler()
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount: corpus.length,
  })

  for (const document of corpus) {
    builder.add(document)
    sampler.sample()
  }
  sampler.sample()
  const peakAfterAddMb = sampler.peakHeapMb()

  const frozen = freezeFrozenIndexBuilder(builder)
  sampler.sample()
  const finished = sampler.finish(frozen)
  const breakdown = frozen._memoryBreakdown()

  const peakHeapMb = finished.peakHeapBytes / 1024 / 1024

  return {
    peakHeapMb,
    peakAfterAddMb,
    freezeDeltaMb: Number((peakHeapMb - peakAfterAddMb).toFixed(4)),
    peakRssMb: finished.peakRssMb,
    breakdownMb: {
      postings: mbRound(breakdown.postings.totalTypedBytes),
      radixTree: mbRound(breakdown.radixTree.estimatedBytes),
      storedFieldsJson: mbRound(breakdown.documents.storedFieldsJsonBytes),
      structuredTotal: mbRound(breakdown.estimatedStructuredBytes),
    },
    termCount: frozen.termCount,
    documentCount: frozen.documentCount,
  }
}

function measureRetainedBuild (corpus, options) {
  const sample = measureHeap(() => {
    const builder = createFrozenIndexBuilder(options, {
      estimatedDocumentCount: corpus.length,
    })
    for (const document of corpus) builder.add(document)
    return freezeFrozenIndexBuilder(builder)
  })
  return mbRound(sample.heapBytes, 4)
}

async function measurePhasedBuildFromStream (spec, options, estimatedDocumentCount) {
  const sampler = createPeakHeapSampler()
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount,
  })

  for await (const document of streamCorpusExportDocuments(spec)) {
    builder.add(document)
    sampler.sample()
  }
  sampler.sample()
  const peakAfterAddMb = sampler.peakHeapMb()

  const frozen = freezeFrozenIndexBuilder(builder)
  sampler.sample()
  const finished = sampler.finish(frozen)
  const breakdown = frozen._memoryBreakdown()

  const peakHeapMb = finished.peakHeapBytes / 1024 / 1024

  return {
    peakHeapMb,
    peakAfterAddMb,
    freezeDeltaMb: Number((peakHeapMb - peakAfterAddMb).toFixed(4)),
    peakRssMb: finished.peakRssMb,
    breakdownMb: {
      postings: mbRound(breakdown.postings.totalTypedBytes),
      radixTree: mbRound(breakdown.radixTree.estimatedBytes),
      storedFieldsJson: mbRound(breakdown.documents.storedFieldsJsonBytes),
      structuredTotal: mbRound(breakdown.estimatedStructuredBytes),
    },
    termCount: frozen.termCount,
    documentCount: frozen.documentCount,
  }
}

async function measureRetainedBuildFromStream (spec, options, estimatedDocumentCount) {
  gc()
  const before = memorySnapshot()
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount,
  })
  for await (const document of streamCorpusExportDocuments(spec)) {
    builder.add(document)
  }
  const frozen = freezeFrozenIndexBuilder(builder)
  gc()
  const after = memorySnapshot()
  void frozen
  return mbRound(Math.max(0, after.heapUsed - before.heapUsed), 4)
}

async function medianBuildFromStream (runs, spec, options, estimatedDocumentCount) {
  const peaks = []
  const retained = []
  for (let i = 0; i < runs; i++) {
    gc()
    peaks.push(await measurePhasedBuildFromStream(spec, options, estimatedDocumentCount))
    gc()
    retained.push(await measureRetainedBuildFromStream(spec, options, estimatedDocumentCount))
  }
  const first = peaks[0]
  const peakHeapMb = medianOf(peaks.map((p) => p.peakHeapMb))
  const peakAfterAddMb = medianOf(peaks.map((p) => p.peakAfterAddMb))
  const retainedHeapMb = medianOf(retained)
  return {
    peakHeapMb: Number(peakHeapMb.toFixed(4)),
    peakAfterAddMb: Number(peakAfterAddMb.toFixed(4)),
    freezeDeltaMb: Number((peakHeapMb - peakAfterAddMb).toFixed(4)),
    peakRssMb: Number(medianOf(peaks.map((p) => p.peakRssMb)).toFixed(3)),
    retainedHeapMb: Number(retainedHeapMb.toFixed(4)),
    peakVsRetainedRatio: peakHeapMb > 0 && retainedHeapMb > 0
      ? Number((peakHeapMb / retainedHeapMb).toFixed(2))
      : null,
    breakdownMb: first.breakdownMb,
    termCount: first.termCount,
    documentCount: first.documentCount,
  }
}

function measureLoadBinaryRetained (filePath, options) {
  if (!existsSync(filePath)) return null
  const sample = measureHeap(() => {
    const buf = readFileSync(filePath)
    return FrozenMiniSearch.loadBinarySync(buf, options)
  })
  return {
    retainedHeapMb: mbRound(sample.heapBytes, 4),
    structuredMb: mbRound(sample.value._memoryBreakdown().estimatedStructuredBytes),
  }
}

function medianBuild (runs, corpus, options) {
  const peaks = []
  const retained = []
  for (let i = 0; i < runs; i++) {
    gc()
    peaks.push(measurePhasedBuild(corpus, options))
    gc()
    retained.push(measureRetainedBuild(corpus, options))
  }
  const first = peaks[0]
  const peakHeapMb = medianOf(peaks.map((p) => p.peakHeapMb))
  const peakAfterAddMb = medianOf(peaks.map((p) => p.peakAfterAddMb))
  const retainedHeapMb = medianOf(retained)
  return {
    peakHeapMb: Number(peakHeapMb.toFixed(4)),
    peakAfterAddMb: Number(peakAfterAddMb.toFixed(4)),
    freezeDeltaMb: Number((peakHeapMb - peakAfterAddMb).toFixed(4)),
    peakRssMb: Number(medianOf(peaks.map((p) => p.peakRssMb)).toFixed(3)),
    retainedHeapMb: Number(retainedHeapMb.toFixed(4)),
    peakVsRetainedRatio: peakHeapMb > 0 && retainedHeapMb > 0
      ? Number((peakHeapMb / retainedHeapMb).toFixed(2))
      : null,
    breakdownMb: first.breakdownMb,
    termCount: first.termCount,
    documentCount: first.documentCount,
  }
}

async function loadCorpusForSpec (source, spec) {
  if (source === 'jsonl') {
    gc()
    const heapBefore = process.memoryUsage().heapUsed
    const stats = await scanCorpusExportStats(spec)
    return {
      documents: null,
      options: spec.options,
      meta: stats,
      corpusHeapMb: mbRound(process.memoryUsage().heapUsed - heapBefore),
      corpusTextMb: mbRound(stats.corpusTextBytes),
      expectedTermCount: null,
      estimatedDocumentCount: stats.documentCount,
    }
  }

  gc()
  const heapBefore = process.memoryUsage().heapUsed
  const extracted = extractCorpusFromMsbinFile(spec.filePath)
  return {
    documents: extracted.documents,
    options: extracted.options,
    meta: extracted.meta,
    corpusHeapMb: mbRound(process.memoryUsage().heapUsed - heapBefore),
    corpusTextMb: mbRound(extracted.meta.corpusTextBytes),
    expectedTermCount: extracted.meta.termCount,
  }
}

async function main () {
  if (typeof global.gc !== 'function') {
    console.warn('Warning: run with --expose-gc for stable peak measurements')
  }

  const runs = parseRuns()
  const only = parseOnly()
  const source = resolveSource()
  const capturedAt = new Date().toISOString()
  const scenarios = []

  const specs = source === 'jsonl'
    ? await loadAllCorpusExportSpecs()
    : allMsbinSpecs()

  const fixturesDir = resolveFixturesDir()
  const outFile = source === 'jsonl'
    ? join(BASELINES, 'medicaments-build-peak-heap.json')
    : join(BASELINES, 'medicaments-build-peak-heap-msbin.json')

  console.log(`Source: ${source}${source === 'jsonl' ? ` (${process.env.CORPUS_EXPORT_DIR ?? DEFAULT_CORPUS_EXPORT_DIR})` : ''}`)

  for (const spec of specs) {
    if (only != null && !only.has(spec.id)) continue

    if (source === 'msbin' && !existsSync(spec.filePath)) {
      console.warn(`\n${spec.id}: skip — missing ${spec.file}`)
      continue
    }

    const docCount = spec.manifestEntry?.documentCount ?? spec.manifest?.documentCount
    console.log(`\n${spec.id} (${docCount ?? '?'} docs, ${source}, ${runs} run(s))`)
    console.log(`  indexed fields:  ${(spec.fields ?? spec.options?.fields ?? []).join(', ')}`)

    const corpus = await loadCorpusForSpec(source, spec)
    gc()
    const build = source === 'jsonl'
      ? await medianBuildFromStream(
        runs,
        spec,
        corpus.options,
        corpus.estimatedDocumentCount,
      )
      : medianBuild(runs, corpus.documents, corpus.options)
    gc()

    const msbinPath = join(fixturesDir, spec.file ?? spec.manifestEntry?.file ?? spec.manifest?.file ?? '')
    const load = measureLoadBinaryRetained(msbinPath, corpus.options)

    const termMatch = corpus.expectedTermCount == null
      ? null
      : build.termCount === corpus.expectedTermCount

    const loadRatio = load != null && load.retainedHeapMb > 0
      ? (build.peakHeapMb / load.retainedHeapMb).toFixed(2)
      : null

    console.log(`  corpus text:     ${corpus.corpusTextMb} MB  corpus heap Δ: ${corpus.corpusHeapMb} MB`)
    console.log(`  build peak:      ${build.peakHeapMb} MB  after add: ${build.peakAfterAddMb} MB  freeze +${build.freezeDeltaMb} MB`)
    console.log(`  build retained:  ${build.retainedHeapMb} MB  peak/retained: ${build.peakVsRetainedRatio}x`)
    if (load != null) {
      console.log(`  loadBinary:      ${load.retainedHeapMb} MB retained  build peak / load: ${loadRatio}x`)
    }
    if (termMatch != null) {
      console.log(`  terms:           ${corpus.expectedTermCount} msbin match: ${termMatch}`)
    } else {
      console.log(`  terms:           ${build.termCount}`)
    }

    scenarios.push({
      id: spec.id,
      source,
      file: spec.file ?? spec.manifestEntry?.file,
      indexedFields: spec.fields ?? corpus.options.fields,
      storeFields: corpus.options.storeFields,
      corpusTextMb: corpus.corpusTextMb,
      corpusHeapMb: corpus.corpusHeapMb,
      corpusMeta: corpus.meta,
      build,
      loadBinary: load,
      termCountMatch: termMatch,
      runs,
    })

    if (corpus.documents != null) corpus.documents.length = 0
    gc()
  }

  const payload = {
    capturedAt,
    node: process.version,
    gcExposed: typeof global.gc === 'function',
    runs,
    corpusSource: source,
    corpusExportDir: source === 'jsonl'
      ? (process.env.CORPUS_EXPORT_DIR ?? null)
      : null,
    note: source === 'jsonl'
      ? 'Corpus JSONL post-parse (indexed fields + id only). Bench models fromDocuments after ETL, not loadBinary.'
      : 'Corpus inverted from .msbin postings. Use SOURCE=jsonl when corpus-export is available.',
    scenarios,
  }

  writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`\nWrote ${outFile}`)
}

main()
