/**
 * Phased heap profile during incremental FrozenIndexBuilder (dev, fast).
 *
 *   ONLY=bdpm-presentations pnpm bench:build-heap-profile
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
} from '../../dist/es/index.js'
import { frozenMemoryBreakdown } from '../harness/frozenDistInternals.mjs'
import {
  loadAllCorpusExportSpecs,
  scanCorpusExportStats,
  streamCorpusExportDocuments,
} from '../loadCorpusExport.js'
import { createPeakHeapSampler, gc, mbRound, measureHeap } from '../benchmarkUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '../baselines/build-heap-profile.json')

function parseOnly () {
  return process.env.ONLY?.split(',')[0]?.trim() || 'bdpm-presentations'
}

function corpusTextMb (documents, fields) {
  let bytes = 0
  for (const doc of documents) {
    for (const f of fields) {
      const v = doc[f]
      if (v != null) bytes += String(v).length
    }
  }
  return mbRound(bytes)
}

async function runBuildProfileFromStream (label, spec, options, stats) {
  gc()
  const corpusText = mbRound(stats.corpusTextBytes)

  gc()
  const corpusHoldMb = mbRound(measureHeap(() => stats).heapBytes)

  gc()
  const sampler = createPeakHeapSampler()
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount: stats.documentCount,
  })

  for await (const doc of streamCorpusExportDocuments(spec)) {
    builder.add(doc)
    sampler.sample()
  }
  const peakAfterAddMb = sampler.peakHeapMb()
  const peakAfterAddTotalResidentMb = sampler.peakTotalResidentMb()

  const frozen = freezeFrozenIndexBuilder(builder)
  sampler.sample()
  const finished = sampler.finish(frozen)
  const peakTotalMb = finished.peakHeapMb
  const peakTotalResidentMb = finished.peakTotalResidentMb
  const peakFreezeDeltaMb = Number((peakTotalMb - peakAfterAddMb).toFixed(3))
  const peakFreezeDeltaTotalResidentMb = Number((peakTotalResidentMb - peakAfterAddTotalResidentMb).toFixed(3))

  gc()
  const retainedMb = Number((measureHeap(() => frozen).heapBytes / 1024 / 1024).toFixed(4))
  const breakdown = frozenMemoryBreakdown(frozen)

  return {
    id: label,
    documentCount: stats.documentCount,
    termCount: frozen.termCount,
    fieldCount: options.fields.length,
    corpusTextMb: corpusText,
    corpusHoldMb,
    peakAfterAddMb,
    peakAfterAddTotalResidentMb,
    peakTotalMb,
    peakTotalResidentMb,
    peakFreezeDeltaMb,
    peakFreezeDeltaTotalResidentMb,
    retainedMb,
    transientMb: Number((peakTotalMb - retainedMb).toFixed(3)),
    structuredMb: mbRound(breakdown.estimatedStructuredBytes),
    componentsMb: {
      postings: mbRound(breakdown.postings.totalTypedBytes),
      radixTree: mbRound(breakdown.radixTree.estimatedBytes),
      storedFieldsJson: mbRound(breakdown.documents.storedFieldsJsonBytes),
      fieldLengthMatrix: mbRound(breakdown.documents.fieldLengthMatrixBytes),
    },
  }
}

function runBuildProfile (label, documents, options) {
  gc()
  const corpusText = corpusTextMb(documents, options.fields)

  gc()
  const corpusHoldMb = mbRound(measureHeap(() => documents).heapBytes)

  gc()
  const sampler = createPeakHeapSampler()
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount: documents.length,
  })

  for (const doc of documents) {
    builder.add(doc)
    sampler.sample()
  }
  const peakAfterAddMb = sampler.peakHeapMb()
  const peakAfterAddTotalResidentMb = sampler.peakTotalResidentMb()

  const frozen = freezeFrozenIndexBuilder(builder)
  sampler.sample()
  const finished = sampler.finish(frozen)
  const peakTotalMb = finished.peakHeapMb
  const peakTotalResidentMb = finished.peakTotalResidentMb
  const peakFreezeDeltaMb = Number((peakTotalMb - peakAfterAddMb).toFixed(3))
  const peakFreezeDeltaTotalResidentMb = Number((peakTotalResidentMb - peakAfterAddTotalResidentMb).toFixed(3))

  gc()
  const retainedMb = Number((measureHeap(() => frozen).heapBytes / 1024 / 1024).toFixed(4))
  const breakdown = frozenMemoryBreakdown(frozen)

  return {
    id: label,
    documentCount: documents.length,
    termCount: frozen.termCount,
    fieldCount: options.fields.length,
    corpusTextMb: corpusText,
    corpusHoldMb,
    peakAfterAddMb,
    peakAfterAddTotalResidentMb,
    peakTotalMb,
    peakTotalResidentMb,
    peakFreezeDeltaMb,
    peakFreezeDeltaTotalResidentMb,
    retainedMb,
    transientMb: Number((peakTotalMb - retainedMb).toFixed(3)),
    structuredMb: mbRound(breakdown.estimatedStructuredBytes),
    componentsMb: {
      postings: mbRound(breakdown.postings.totalTypedBytes),
      radixTree: mbRound(breakdown.radixTree.estimatedBytes),
      storedFieldsJson: mbRound(breakdown.documents.storedFieldsJsonBytes),
      fieldLengthMatrix: mbRound(breakdown.documents.fieldLengthMatrixBytes),
    },
  }
}

function syntheticCorpus (documentCount, fieldCount) {
  const fields = Array.from({ length: fieldCount }, (_, i) => `f${i}`)
  const options = { fields, storeFields: ['id'] }
  const documents = Array.from({ length: documentCount }, (_, i) => {
    const doc = { id: i }
    for (let f = 0; f < fieldCount; f++) {
      doc[fields[f]] = `term${f % 3} repeated token pool`
    }
    return doc
  })
  return { documents, options }
}

async function main () {
  const only = parseOnly()
  const specs = await loadAllCorpusExportSpecs()
  const spec = specs.find((s) => s.id === only)
  if (spec == null) throw new Error(`Missing corpus: ${only}`)

  const stats = await scanCorpusExportStats(spec)
  const real = await runBuildProfileFromStream(only, spec, spec.options, stats)
  gc()

  const { documents: synDocs, options: synOpts } = syntheticCorpus(
    real.documentCount,
    real.fieldCount,
  )
  const synthetic = runBuildProfile(`${only}-synthetic-few-terms`, synDocs, synOpts)
  synDocs.length = 0
  gc()

  const { documents: synDocs1f, options: synOpts1f } = syntheticCorpus(real.documentCount, 1)
  const syntheticOneField = runBuildProfile(`${only}-synthetic-1field`, synDocs1f, synOpts1f)
  synDocs1f.length = 0
  gc()

  const payload = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    note: 'One sampler per build (add+freeze). Compare real vs synthetic-few-terms: extra transient ≈ radix growth. synthetic-1field isolates multi-field per-doc cost.',
    scenarios: { real, synthetic, syntheticOneField },
    inference: {
      radixHeavyTransientMb: Number((real.transientMb - synthetic.transientMb).toFixed(3)),
      multiFieldPremiumMb: Number((real.transientMb - syntheticOneField.transientMb).toFixed(3)),
      structuredPostingsPct: real.structuredMb > 0
        ? Number((100 * real.componentsMb.postings / real.structuredMb).toFixed(1))
        : null,
      transientVsStructuredRatio: Number((real.transientMb / real.structuredMb).toFixed(1)),
    },
  }

  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)

  console.log(`\n=== build heap profile: ${only} ===\n`)
  for (const row of [real, synthetic, syntheticOneField]) {
    console.log(`  [${row.id}]`)
    console.log(`    terms ${row.termCount}  peak heap ${row.peakTotalMb} MB / total ${row.peakTotalResidentMb} MB (add heap ${row.peakAfterAddMb} / total ${row.peakAfterAddTotalResidentMb}  freeze Δheap ${row.peakFreezeDeltaMb} / Δtotal ${row.peakFreezeDeltaTotalResidentMb})`)
    console.log(`    retained ${row.retainedMb} MB  transient ${row.transientMb} MB  structured ${row.structuredMb} MB`)
    console.log(`    components: postings ${row.componentsMb.postings}  radix ${row.componentsMb.radixTree}  stored ${row.componentsMb.storedFieldsJson}`)
    console.log('')
  }
  console.log(`  radix-heavy transient (real − few-terms):  ~${payload.inference.radixHeavyTransientMb} MB`)
  console.log(`  multi-field premium (real − 1-field syn):  ~${payload.inference.multiFieldPremiumMb} MB`)
  console.log(`  transient / structured (real):             ~${payload.inference.transientVsStructuredRatio}×`)
  console.log(`\nWrote ${OUT}`)
}

main()
