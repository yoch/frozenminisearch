import MiniSearch, { FrozenMiniSearch, frozenMemoryBreakdown } from '../dist/es/index.js'
import { loadDivinaLines } from './loadDivinaLines.js'
import {
  giantVocabulary,
  largeDocuments,
  manyFields,
  highFrequencyTerms,
  overflowFrequencies,
  denseNumericIds,
  genericStringIds,
  sparseFields,
  docIdUint16Boundary
} from './benchmarkScenarios.js'
import {
  gc,
  mbRound,
  pctDeltaRound,
  measureHeap,
  benchSearch,
  timedMs
} from './benchmarkUtils.js'

function median (values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

function medianRound (values, digits) {
  return Number(median(values).toFixed(digits))
}

function aggregateSearch (runs) {
  const base = runs[0].search
  return base.map((row) => {
    const matches = runs.map((r) => r.search.find((x) => x.label === row.label)).filter(Boolean)
    const mutableP50 = medianRound(matches.map((m) => m.mutableP50), 4)
    const frozenP50 = medianRound(matches.map((m) => m.frozenP50), 4)
    const mutableP95 = medianRound(matches.map((m) => m.mutableP95), 4)
    const frozenP95 = medianRound(matches.map((m) => m.frozenP95), 4)
    const frozenP50VsMutablePct = pctDeltaRound(mutableP50, frozenP50)
    return {
      label: row.label,
      query: row.query,
      mutableP50,
      frozenP50,
      mutableP95,
      frozenP95,
      frozenP50VsMutablePct
    }
  })
}

function aggregateScoreDrift (runs) {
  const first = runs[0].scoreDrift
  if (!first) return undefined
  return first.map((row) => {
    const matches = runs.map((r) => (r.scoreDrift || []).find((x) => x.query === row.query)).filter(Boolean)
    const maxAbsScoreDelta = medianRound(matches.map((m) => m.maxAbsScoreDelta), 6)
    const maxRelScoreDeltaPct = medianRound(matches.map((m) => m.maxRelScoreDeltaPct), 2)
    const missingInFrozenTopK = Math.round(median(matches.map((m) => m.missingInFrozenTopK)))
    const topKOrderChanged = matches.some((m) => m.topKOrderChanged)
    return {
      query: row.query,
      topK: row.topK,
      maxAbsScoreDelta,
      maxRelScoreDeltaPct,
      missingInFrozenTopK,
      topKOrderChanged
    }
  })
}

function aggregateScenarioRuns (runs) {
  const base = runs[0]
  const indexing = {
    addAllMs: medianRound(runs.map((r) => r.indexing.addAllMs), 2),
    freezeMs: medianRound(runs.map((r) => r.indexing.freezeMs), 2),
    fromDocumentsMs: medianRound(runs.map((r) => r.indexing.fromDocumentsMs), 2),
    jsonSerializeMs: medianRound(runs.map((r) => r.indexing.jsonSerializeMs), 2),
    saveBinaryMs: medianRound(runs.map((r) => r.indexing.saveBinaryMs), 2),
    binaryMagic: base.indexing.binaryMagic
  }

  const heapMutable = medianRound(runs.map((r) => r.heapMb.mutable), 3)
  const heapFrozen = medianRound(runs.map((r) => r.heapMb.frozen), 3)
  const heapBuildMutableFreeze = medianRound(runs.map((r) => r.heapMb.buildMutableFreeze), 3)
  const heapBuildFromDocuments = medianRound(runs.map((r) => r.heapMb.buildFromDocuments), 3)
  const heapLoadJson = medianRound(runs.map((r) => r.heapMb.loadJson), 3)
  const heapLoadBinary = medianRound(runs.map((r) => r.heapMb.loadBinary), 3)
  const heapSavingPct = heapMutable > 0
    ? Number((100 * (1 - heapFrozen / heapMutable)).toFixed(1))
    : 0
  const buildHeapSavingPct = heapBuildMutableFreeze > 0
    ? Number((100 * (1 - heapBuildFromDocuments / heapBuildMutableFreeze)).toFixed(1))
    : 0

  const diskJson = medianRound(runs.map((r) => r.diskMb.json), 3)
  const diskBinary = medianRound(runs.map((r) => r.diskMb.binary), 3)
  const diskSavingPct = diskJson > 0
    ? Number((100 * (1 - diskBinary / diskJson)).toFixed(1))
    : 0

  const loadJson = medianRound(runs.map((r) => r.loadMs.json), 2)
  const loadBinary = medianRound(runs.map((r) => r.loadMs.binary), 2)
  const loadSavingPct = loadJson > 0
    ? Number((100 * (1 - loadBinary / loadJson)).toFixed(1))
    : 0

  const memoryBreakdown = base.memoryBreakdown
    ? {
        termCount: base.memoryBreakdown.termCount,
        documentCount: base.memoryBreakdown.documentCount,
        nextId: base.memoryBreakdown.nextId,
        postings: {
          slotCount: base.memoryBreakdown.postings.slotCount,
          allDocIdsBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.postings.allDocIdsBytes))),
          allFreqsBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.postings.allFreqsBytes))),
          offsetsBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.postings.offsetsBytes))),
          lengthsBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.postings.lengthsBytes))),
          totalTypedBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.postings.totalTypedBytes)))
        },
        radixTree: {
          mapNodeCount: base.memoryBreakdown.radixTree.mapNodeCount,
          estimatedBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.radixTree.estimatedBytes)))
        },
        documents: {
          externalIdsSlots: base.memoryBreakdown.documents.externalIdsSlots,
          storedFieldsSlots: base.memoryBreakdown.documents.storedFieldsSlots,
          idToShortIdEntries: base.memoryBreakdown.documents.idToShortIdEntries,
          fieldLengthMatrixBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.documents.fieldLengthMatrixBytes))),
          avgFieldLengthBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.documents.avgFieldLengthBytes))),
          storedFieldsJsonBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.documents.storedFieldsJsonBytes)))
        },
        estimatedStructuredBytes: Math.round(median(runs.map((r) => r.memoryBreakdown.estimatedStructuredBytes)))
      }
    : undefined

  const search = aggregateSearch(runs)
  const scoreDrift = aggregateScoreDrift(runs)
  const avgFrozenP50GainPct = search.length > 0
    ? Number((search.reduce((s, r) => s + (1 - r.frozenP50 / r.mutableP50), 0) / search.length * 100).toFixed(1))
    : 0

  return {
    id: base.id,
    name: base.name,
    documentCount: base.documentCount,
    fields: base.fields,
    storeFields: base.storeFields,
    indexing,
    heapMb: {
      mutable: heapMutable,
      frozen: heapFrozen,
      buildMutableFreeze: heapBuildMutableFreeze,
      buildFromDocuments: heapBuildFromDocuments,
      buildFromDocumentsVsMutableFreezeSavingPct: buildHeapSavingPct,
      loadJson: heapLoadJson,
      loadBinary: heapLoadBinary,
      frozenVsMutableSavingPct: heapSavingPct
    },
    diskMb: {
      json: diskJson,
      binary: diskBinary,
      binaryVsJsonSavingPct: diskSavingPct
    },
    loadMs: {
      json: loadJson,
      binary: loadBinary,
      binaryVsJsonSavingPct: loadSavingPct
    },
    memoryBreakdown,
    search,
    scoreDrift,
    summary: {
      heapFrozenVsMutableSavingPct: heapSavingPct,
      diskBinaryVsJsonSavingPct: diskSavingPct,
      loadBinaryVsJsonSavingPct: loadSavingPct,
      searchFrozenP50AvgGainPct: avgFrozenP50GainPct
    }
  }
}

export function buildScenarioList () {
  const divina = loadDivinaLines()
  const many = manyFields()
  const sparse = sparseFields(5000, 20)

  return [
    {
      id: 'divina-storeFields',
      name: 'Divina Commedia — with storeFields',
      corpus: divina,
      options: { fields: ['txt'], storeFields: ['txt'] },
      queries: [
        { label: 'exact', q: 'inferno', opts: {} },
        { label: 'AND', q: 'inferno paradiso', opts: { combineWith: 'AND' } },
        { label: 'prefix', q: 'infe', opts: { prefix: true } },
        { label: 'fuzzy', q: 'infern', opts: { fuzzy: 0.2 } }
      ]
    },
    {
      id: 'divina-indexOnly',
      name: 'Divina Commedia — index only',
      corpus: divina,
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'inferno', opts: {} },
        { label: 'prefix', q: 'infe', opts: { prefix: true } }
      ]
    },
    {
      id: 'extreme-giantVocabulary',
      name: 'Extreme — giant vocabulary (50k unique terms)',
      corpus: giantVocabulary(50000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'unique12345', opts: {} },
        { label: 'prefix', q: 'unique1', opts: { prefix: true } }
      ]
    },
    {
      id: 'extreme-largeDocuments',
      name: 'Extreme — large documents (5k × ~5KB, storeFields)',
      corpus: largeDocuments(5000, 5000),
      options: { fields: ['txt'], storeFields: ['txt'] },
      queries: [
        { label: 'exact', q: 'lorem', opts: {} },
        { label: 'AND', q: 'lorem ipsum', opts: { combineWith: 'AND' } }
      ]
    },
    {
      id: 'extreme-manyFields',
      name: 'Extreme — many fields (2k docs × 10 fields)',
      corpus: many.docs,
      options: { fields: many.fields, storeFields: [] },
      queries: [
        { label: 'exact', q: 'sharedterm', opts: {} },
        { label: 'prefix', q: 'share', opts: { prefix: true } }
      ]
    },
    {
      id: 'extreme-highFrequency',
      name: 'Extreme — high-frequency terms (10k docs)',
      corpus: highFrequencyTerms(10000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} },
        { label: 'AND', q: 'alpha beta', opts: { combineWith: 'AND' } }
      ]
    },
    {
      id: 'extreme-overflowFrequency',
      name: 'Extreme — overflow frequencies (>255)',
      corpus: overflowFrequencies(2000, 800),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} }
      ],
      driftQueries: ['alpha']
    },
    {
      id: 'denseNumericIds-100k',
      name: 'Dense numeric ids (100k, identity lookup)',
      corpus: denseNumericIds(100000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'token42', opts: {} }
      ]
    },
    {
      id: 'genericStringIds-100k',
      name: 'Generic string ids (100k, lazy-map lookup)',
      corpus: genericStringIds(100000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'token42', opts: {} }
      ]
    },
    {
      id: 'sparseFields-50kTerms-20Fields',
      name: 'Sparse fields (5k docs × 20 fields, one active field/doc)',
      corpus: sparse.docs,
      options: {
        fields: sparse.fields,
        storeFields: []
      },
      queries: [
        { label: 'exact', q: 'shared', opts: {} }
      ]
    },
    {
      id: 'docIdUint16Boundary-65535',
      name: 'Doc id Uint16 boundary (65535 docs)',
      corpus: docIdUint16Boundary(65535),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} }
      ]
    },
    {
      id: 'docIdUint16Boundary-65536',
      name: 'Doc id Uint32 boundary (65536 docs)',
      corpus: docIdUint16Boundary(65536),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'alpha', opts: {} }
      ]
    },
    {
      id: 'saveBinaryAfterNoTerms',
      name: 'saveBinary dictionary rebuild (50k terms)',
      corpus: giantVocabulary(50000),
      options: { fields: ['txt'], storeFields: [] },
      queries: [
        { label: 'exact', q: 'unique9999', opts: {} }
      ]
    }
  ]
}

function computeScoreDrift (mutable, frozen, query, limit = 20) {
  const a = mutable.search(query).slice(0, limit)
  const b = frozen.search(query).slice(0, limit)
  const bMap = new Map(b.map((r) => [r.id, r.score]))
  let maxAbs = 0
  let maxRel = 0
  let missing = 0
  for (const row of a) {
    const score = bMap.get(row.id)
    if (score == null) {
      missing++
      continue
    }
    const abs = Math.abs(score - row.score)
    const rel = row.score ? abs / row.score : 0
    if (abs > maxAbs) maxAbs = abs
    if (rel > maxRel) maxRel = rel
  }
  const aIds = a.map((r) => r.id).join('|')
  const bIds = b.map((r) => r.id).join('|')
  return {
    query,
    topK: limit,
    maxAbsScoreDelta: Number(maxAbs.toFixed(6)),
    maxRelScoreDeltaPct: Number((maxRel * 100).toFixed(2)),
    missingInFrozenTopK: missing,
    topKOrderChanged: aIds !== bIds
  }
}

/**
 * Run one benchmark scenario and return JSON-serializable metrics.
 */
export function runScenario (scenario) {
  const { id, name, corpus, options, queries, driftQueries } = scenario

  let json
  let binaryBuf
  let indexMs
  let freezeMs
  let fromDocumentsMs
  let jsonSerializeMs
  let binarySerializeMs

  {
    const ms = timedMs(() => {
      const m = new MiniSearch(options)
      m.addAll(corpus)
      return m
    })
    indexMs = ms.ms
    const ser = timedMs(() => JSON.stringify(ms.result))
    json = ser.result
    jsonSerializeMs = ser.ms
    const fr = timedMs(() => ms.result.freeze())
    freezeMs = fr.ms
    const bin = timedMs(() => fr.result.saveBinary())
    binaryBuf = bin.result
    binarySerializeMs = bin.ms
    const direct = timedMs(() => FrozenMiniSearch.fromDocuments(corpus, options))
    fromDocumentsMs = direct.ms
  }

  const jsonMb = mbRound(json.length)
  const binaryMb = mbRound(binaryBuf.length)
  const binaryMagic = binaryBuf.toString('ascii', 0, 4)
  gc()

  const heapMutable = measureHeap(() => {
    const ms = new MiniSearch(options)
    ms.addAll(corpus)
    return ms
  })

  const heapFrozen = measureHeap(() => {
    const ms = new MiniSearch(options)
    ms.addAll(corpus)
    return ms.freeze()
  })

  const heapBuildMutableFreeze = measureHeap(() => {
    const ms = new MiniSearch(options)
    ms.addAll(corpus)
    return ms.freeze()
  })

  const heapBuildFromDocuments = measureHeap(() => {
    return FrozenMiniSearch.fromDocuments(corpus, options)
  })

  const breakdown = frozenMemoryBreakdown(heapFrozen.value)

  const heapJsonLoaded = measureHeap(() => MiniSearch.loadJSON(json, options))
  const heapBinaryLoaded = measureHeap(() => FrozenMiniSearch.loadBinary(binaryBuf, options))

  gc()
  const loadJson = timedMs(() => MiniSearch.loadJSON(json, options))
  gc()
  const loadBinary = timedMs(() => FrozenMiniSearch.loadBinary(binaryBuf, options))
  gc()

  function withIndex (factory, fn) {
    gc()
    let out
    {
      const index = factory()
      out = fn(index)
    }
    gc()
    return out
  }

  const search = []
  for (const { label, q, opts } of queries) {
    const mutable = withIndex(() => {
      const ms = new MiniSearch(options)
      ms.addAll(corpus)
      return ms
    }, (idx) => benchSearch(idx, q, opts))

    const frozen = withIndex(() => {
      const ms = new MiniSearch(options)
      ms.addAll(corpus)
      return ms.freeze()
    }, (idx) => benchSearch(idx, q, opts))

    search.push({
      label,
      query: q,
      mutableP50: Number(mutable.p50.toFixed(4)),
      frozenP50: Number(frozen.p50.toFixed(4)),
      mutableP95: Number(mutable.p95.toFixed(4)),
      frozenP95: Number(frozen.p95.toFixed(4)),
      frozenP50VsMutablePct: pctDeltaRound(mutable.p50, frozen.p50)
    })
  }

  const heapSavingPct = heapMutable.heapMb > 0
    ? Number((100 * (1 - heapFrozen.heapMb / heapMutable.heapMb)).toFixed(1))
    : 0

  const avgFrozenP50GainPct = search.length > 0
    ? Number((search.reduce((s, r) => s + (1 - r.frozenP50 / r.mutableP50), 0) / search.length * 100).toFixed(1))
    : 0

  let scoreDrift
  if (driftQueries && driftQueries.length > 0) {
    const ms = new MiniSearch(options)
    ms.addAll(corpus)
    const frozen = ms.freeze()
    scoreDrift = driftQueries.map((query) => computeScoreDrift(ms, frozen, query))
  }

  return {
    id,
    name,
    documentCount: corpus.length,
    fields: options.fields,
    storeFields: options.storeFields || [],
    indexing: {
      addAllMs: Number(indexMs.toFixed(2)),
      freezeMs: Number(freezeMs.toFixed(2)),
      fromDocumentsMs: Number(fromDocumentsMs.toFixed(2)),
      jsonSerializeMs: Number(jsonSerializeMs.toFixed(2)),
      saveBinaryMs: Number(binarySerializeMs.toFixed(2)),
      binaryMagic
    },
    heapMb: {
      mutable: heapMutable.heapMb,
      frozen: heapFrozen.heapMb,
      buildMutableFreeze: heapBuildMutableFreeze.heapMb,
      buildFromDocuments: heapBuildFromDocuments.heapMb,
      buildFromDocumentsVsMutableFreezeSavingPct: heapBuildMutableFreeze.heapMb > 0
        ? Number((100 * (1 - heapBuildFromDocuments.heapMb / heapBuildMutableFreeze.heapMb)).toFixed(1))
        : 0,
      loadJson: heapJsonLoaded.heapMb,
      loadBinary: heapBinaryLoaded.heapMb,
      frozenVsMutableSavingPct: heapSavingPct
    },
    memoryMb: {
      frozen: {
        heapUsed: heapFrozen.heapMb,
        external: heapFrozen.externalMb,
        arrayBuffers: heapFrozen.arrayBuffersMb,
        rss: heapFrozen.rssMb,
        totalResidentApprox: heapFrozen.totalResidentApproxMb
      },
      mutable: {
        heapUsed: heapMutable.heapMb,
        external: heapMutable.externalMb,
        arrayBuffers: heapMutable.arrayBuffersMb,
        rss: heapMutable.rssMb,
        totalResidentApprox: heapMutable.totalResidentApproxMb
      }
    },
    diskMb: {
      json: jsonMb,
      binary: binaryMb,
      binaryVsJsonSavingPct: jsonMb > 0
        ? Number((100 * (1 - binaryMb / jsonMb)).toFixed(1))
        : 0
    },
    loadMs: {
      json: Number(loadJson.ms.toFixed(2)),
      binary: Number(loadBinary.ms.toFixed(2)),
      binaryVsJsonSavingPct: loadJson.ms > 0
        ? Number((100 * (1 - loadBinary.ms / loadJson.ms)).toFixed(1))
        : 0
    },
    memoryBreakdown: breakdown,
    search,
    scoreDrift,
    summary: {
      heapFrozenVsMutableSavingPct: heapSavingPct,
      diskBinaryVsJsonSavingPct: jsonMb > 0 ? Number((100 * (1 - binaryMb / jsonMb)).toFixed(1)) : 0,
      loadBinaryVsJsonSavingPct: loadJson.ms > 0 ? Number((100 * (1 - loadBinary.ms / loadJson.ms)).toFixed(1)) : 0,
      searchFrozenP50AvgGainPct: avgFrozenP50GainPct
    }
  }
}

export function runBenchmarkSuite (scenarios = buildScenarioList(), runs = 1) {
  if (runs <= 1) {
    return scenarios.map((scenario) => runScenario(scenario))
  }
  return scenarios.map((scenario) => {
    const results = []
    for (let i = 0; i < runs; i++) {
      results.push(runScenario(scenario))
    }
    return aggregateScenarioRuns(results)
  })
}
