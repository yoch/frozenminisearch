/**
 * Compare MiniSearch (mutable) vs FrozenMiniSearch — human-readable report.
 * JSON metrics: yarn benchmark:record | yarn benchmark:diff
 *
 * Run: yarn benchmark:compare
 * Requires: yarn build && node --expose-gc
 */
import { buildScenarioList, runBenchmarkSuite } from './benchmarkSuite.js'
import { parseRunsArg } from './benchmarkUtils.js'

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2)

const pct = (base, value) => {
  if (base === 0) return '—'
  const delta = ((value - base) / base) * 100
  const sign = delta <= 0 ? '' : '+'
  return `${sign}${delta.toFixed(1)}%`
}

function printTable (rows) {
  const col = (s, w) => String(s).padEnd(w)
  const w = [28, 14, 14, 14, 12]
  console.log(col('Scenario', w[0]) + col('Heap (MB)', w[1]) + col('Disk (MB)', w[2]) + col('Load (ms)', w[3]) + col('vs mutable', w[4]))
  console.log('-'.repeat(w.reduce((a, b) => a + b, 0)))
  for (const r of rows) {
    console.log(
      col(r.label, w[0]) +
      col(r.heapMb ?? '—', w[1]) +
      col(r.diskMb ?? '—', w[2]) +
      col(r.loadMs != null ? r.loadMs.toFixed(1) : '—', w[3]) +
      col(r.vsMutable ?? '—', w[4])
    )
  }
}

function printMemoryBreakdown (b) {
  console.log('\nMemory breakdown (FrozenMiniSearch, estimated structured bytes):')
  console.log(`  terms: ${b.termCount}, docs: ${b.documentCount}, nextId slots: ${b.nextId}`)
  console.log(`  postings typed arrays: ${mb(b.postings.totalTypedBytes)} MB  (docIds ${mb(b.postings.allDocIdsBytes)}, freqs ${mb(b.postings.allFreqsBytes)})`)
  console.log(`  radix tree (~${b.radixTree.mapNodeCount} Map nodes): ~${mb(b.radixTree.estimatedBytes)} MB`)
  console.log(`  stored fields (JSON est.): ${mb(b.documents.storedFieldsJsonBytes)} MB`)
  console.log(`  field length matrix: ${mb(b.documents.fieldLengthMatrixBytes)} MB`)
  console.log(`  idToShortId entries: ${b.documents.idToShortIdEntries}`)
  console.log(`  total structured estimate: ${mb(b.estimatedStructuredBytes)} MB`)
}

function printScenario (data) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`Profile: ${data.name}`)
  console.log(`  documents: ${data.documentCount}, fields: [${data.fields.join(', ')}], storeFields: [${data.storeFields.join(', ') || '(none)'}]`)
  console.log('='.repeat(72))

  printMemoryBreakdown(data.memoryBreakdown)

  console.log('\nIndexing:')
  console.log(`  addAll:         ${data.indexing.addAllMs.toFixed(1)} ms`)
  console.log(`  freeze:         ${data.indexing.freezeMs.toFixed(1)} ms  (offline, once)`)
  console.log(`  JSON.stringify: ${data.indexing.jsonSerializeMs.toFixed(1)} ms`)
  console.log(`  saveBinary:     ${data.indexing.saveBinaryMs.toFixed(1)} ms  (format ${data.indexing.binaryMagic})`)

  const baseHeap = data.heapMb.mutable
  printTable([
    { label: 'Mutable MiniSearch', heapMb: data.heapMb.mutable.toFixed(2), diskMb: data.diskMb.json.toFixed(2), loadMs: data.loadMs.json, vsMutable: 'baseline' },
    { label: 'FrozenMiniSearch', heapMb: data.heapMb.frozen.toFixed(2), diskMb: data.diskMb.binary.toFixed(2), loadMs: null, vsMutable: pct(baseHeap, data.heapMb.frozen) },
    { label: 'loadJSON → MiniSearch', heapMb: data.heapMb.loadJson.toFixed(2), diskMb: data.diskMb.json.toFixed(2), loadMs: data.loadMs.json, vsMutable: pct(baseHeap, data.heapMb.loadJson) },
    { label: 'loadBinary → Frozen', heapMb: data.heapMb.loadBinary.toFixed(2), diskMb: data.diskMb.binary.toFixed(2), loadMs: data.loadMs.binary, vsMutable: pct(baseHeap, data.heapMb.loadBinary) }
  ])

  console.log('\nCold load:')
  console.log(`  loadJSON:   ${data.loadMs.json.toFixed(1)} ms`)
  console.log(`  loadBinary: ${data.loadMs.binary.toFixed(1)} ms  (${pct(data.loadMs.json, data.loadMs.binary)} vs loadJSON)`)

  console.log('\nSearch p50 / p95 (ms):\n')
  console.log('Query'.padEnd(12) + 'Mutable p50'.padEnd(14) + 'Frozen p50'.padEnd(14) + 'Δ p50'.padEnd(10) + 'Mutable p95'.padEnd(14) + 'Frozen p95')
  console.log('-'.repeat(68))
  for (const row of data.search) {
    console.log(
      row.label.padEnd(12) +
      row.mutableP50.toFixed(3).padEnd(14) +
      row.frozenP50.toFixed(3).padEnd(14) +
      pct(row.mutableP50, row.frozenP50).padEnd(10) +
      row.mutableP95.toFixed(3).padEnd(14) +
      row.frozenP95.toFixed(3)
    )
  }

  console.log('\nProfile summary:')
  console.log(`  RAM frozen vs mutable (isolated):  ${data.summary.heapFrozenVsMutableSavingPct.toFixed(1)}% smaller`)
  console.log(`  Disk binary vs JSON:               ${data.summary.diskBinaryVsJsonSavingPct.toFixed(1)}% smaller`)
  console.log(`  Cold load binary vs JSON:          ${data.summary.loadBinaryVsJsonSavingPct.toFixed(1)}% faster`)
  console.log(`  Search p50 (avg across queries):   ${data.summary.searchFrozenP50AvgGainPct.toFixed(1)}% faster on frozen`)

  if (data.scoreDrift && data.scoreDrift.length > 0) {
    console.log('\nScore drift (mutable vs frozen):')
    for (const row of data.scoreDrift) {
      console.log(`  ${row.query}: max Δ=${row.maxAbsScoreDelta} (rel ${row.maxRelScoreDeltaPct}%), missing topK=${row.missingInFrozenTopK}, orderChanged=${row.topKOrderChanged}`)
    }
  }
}

const runs = parseRunsArg()

console.log('=== MiniSearch vs FrozenMiniSearch (isolated measurements) ===\n')
if (runs > 1) {
  console.log(`Using ${runs} runs per scenario (median aggregation)\n`)
}

if (!global.gc) {
  console.log('Tip: run with --expose-gc for accurate heap numbers.\n')
}

for (const result of runBenchmarkSuite(buildScenarioList(), runs)) {
  printScenario(result)
}

console.log('\n' + '='.repeat(72))
console.log('JSON baselines')
console.log('='.repeat(72))
console.log('• yarn benchmark:record          → benchmarks/baselines/latest.json')
console.log('• yarn benchmark:diff          → compare run vs reference.json')
console.log('• yarn benchmark:baseline:update → promote latest to reference')
console.log('='.repeat(72))
console.log('Notes')
console.log('='.repeat(72))
console.log('• Heap is measured with one index alive; use --expose-gc for stable numbers.')
console.log('• Memory breakdown estimates structured data; V8 object overhead is additional.')
console.log('• saveBinary writes MSv3 (flat postings + binary metadata); loadBinary reads MSv3 only.')
console.log('• Production: build mutable → freeze() → release mutable → serve frozen (or loadBinary).\n')
