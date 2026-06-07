import MiniSearch from 'minisearch'
import FrozenMiniSearch, { frozenMemoryBreakdown } from '../dist/es/index.js'
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
import { median, medianRound } from './benchStats.js'
import {
  gc,
  mbRound,
  frozenVsMutablePct,
  measureHeap,
  benchSearchPaired,
  searchIterationsForBatchEntry,
  timedMs,
  defaultBenchmarkRuns,
} from './benchmarkUtils.js'
import { applySearchBenchBatchesToScenarios, getSearchBenchBatchEntry } from './loadSearchBenchBatches.js'
import { benchSearchLevels, primaryLookupTerm } from './searchLevels.js'
import { ALL_SURFACES, computeSurfaceNeeds } from './framework/surfaces.mjs'

function avgFrozenP50GainPct (search) {
  return search.length > 0
    ? Number((search.reduce((s, r) => s + (1 - r.frozenP50 / r.mutableP50), 0) / search.length * 100).toFixed(1))
    : 0
}

function prepareScenarioSearchIndexes (corpus, options) {
  gc()
  const mutableSearchIndex = new MiniSearch(options)
  mutableSearchIndex.addAll(corpus)
  gc()
  const frozenBuild = new MiniSearch(options)
  frozenBuild.addAll(corpus)
  const frozenSearchIndex = FrozenMiniSearch.fromMiniSearch(frozenBuild, options)
  gc()
  return { mutableSearchIndex, frozenSearchIndex }
}

function benchScenarioSearch (mutableSearchIndex, frozenSearchIndex, queries, scenarioId, { searchLevels = false } = {}) {
  const search = []
  const levels = searchLevels ? {} : undefined

  for (const { label, q, opts, benchBatch } of queries) {
    if (!benchBatch) {
      throw new Error(`Missing benchBatch for search "${label}" (run benchmark:calibrate-batches)`)
    }
    const batchEntry = getSearchBenchBatchEntry(scenarioId, label)
    const iterations = searchIterationsForBatchEntry(batchEntry)
    const benchOpts = { batchSize: benchBatch }
    const paired = benchSearchPaired(
      mutableSearchIndex,
      frozenSearchIndex,
      q,
      opts,
      iterations,
      benchOpts,
    )
    search.push({
      label,
      query: q,
      batchSize: benchBatch,
      searchIterations: iterations,
      mutableP50: Number(paired.mutableP50.toFixed(4)),
      frozenP50: Number(paired.frozenP50.toFixed(4)),
      mutableP95: Number(paired.mutableP95.toFixed(4)),
      frozenP95: Number(paired.frozenP95.toFixed(4)),
      pairedRatioP50: paired.pairedRatioP50 == null
        ? null
        : Number(paired.pairedRatioP50.toFixed(4)),
      frozenP50VsMutablePct: frozenVsMutablePct(paired.mutableP50, paired.frozenP50),
      belowSearchFloor: paired.mutableP50 < 0.1,
    })

    if (searchLevels) {
      const term = primaryLookupTerm(mutableSearchIndex, q, opts)
      levels[label] = benchSearchLevels(
        mutableSearchIndex,
        frozenSearchIndex,
        q,
        opts,
        term,
        iterations,
        benchBatch,
      )
    }
  }
  gc()
  return {
    search,
    searchLevels: levels,
    avgFrozenP50GainPct: avgFrozenP50GainPct(search),
  }
}

function aggregatePairedLevel (levels) {
  const pairedRatioSamples = levels
    .map((l) => l.pairedRatioP50)
    .filter((v) => v != null)
  const mutableP50 = medianRound(levels.map((l) => l.mutableP50), 4)
  const frozenP50 = medianRound(levels.map((l) => l.frozenP50), 4)
  return {
    mutableP50,
    mutableP95: medianRound(levels.map((l) => l.mutableP95), 4),
    frozenP50,
    frozenP95: medianRound(levels.map((l) => l.frozenP95), 4),
    pairedRatioP50: pairedRatioSamples.length
      ? medianRound(pairedRatioSamples, 4)
      : null,
    frozenP50VsMutablePct: frozenVsMutablePct(mutableP50, frozenP50),
    batchSize: levels[0].batchSize,
  }
}

function aggregateFrozenLevel (levels) {
  return {
    frozenP50: medianRound(levels.map((l) => l.frozenP50), 4),
    frozenP95: medianRound(levels.map((l) => l.frozenP95), 4),
    batchSize: levels[0].batchSize,
  }
}

function aggregateSearch (runs) {
  const base = runs[0].search
  return base.map((row) => {
    const matches = runs.map((r) => r.search.find((x) => x.label === row.label)).filter(Boolean)
    const mutableP50 = medianRound(matches.map((m) => m.mutableP50), 4)
    const frozenP50 = medianRound(matches.map((m) => m.frozenP50), 4)
    const mutableP95 = medianRound(matches.map((m) => m.mutableP95), 4)
    const frozenP95 = medianRound(matches.map((m) => m.frozenP95), 4)
    const pairedRatioP50 = medianRound(
      matches.map((m) => m.pairedRatioP50).filter((v) => v != null),
      4,
    )
    return {
      label: row.label,
      query: row.query,
      batchSize: row.batchSize,
      searchIterations: row.searchIterations,
      mutableP50,
      frozenP50,
      mutableP95,
      frozenP95,
      pairedRatioP50: Number.isFinite(pairedRatioP50) ? pairedRatioP50 : null,
      frozenP50VsMutablePct: frozenVsMutablePct(mutableP50, frozenP50),
      belowSearchFloor: mutableP50 < 0.1,
    }
  })
}

function aggregateSearchLevels (runs) {
  const first = runs[0].searchLevels
  if (!first) return undefined
  const out = {}
  for (const label of Object.keys(first)) {
    const matches = runs.map((r) => r.searchLevels?.[label]).filter(Boolean)
    if (matches.length === 0) continue
    out[label] = {
      term: matches[0].term,
      L0: aggregatePairedLevel(matches.map((m) => m.L0)),
      L1: aggregateFrozenLevel(matches.map((m) => m.L1)),
      L2: aggregatePairedLevel(matches.map((m) => m.L2)),
    }
  }
  return out
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
  if (base.benchProfile === 'search' || (base.benchSurfaces?.length === 1 && base.benchSurfaces[0] === 'search')) {
    const search = aggregateSearch(runs)
    const searchLevels = aggregateSearchLevels(runs)
    return {
      id: base.id,
      name: base.name,
      documentCount: base.documentCount,
      fields: base.fields,
      storeFields: base.storeFields,
      benchProfile: 'search',
      benchSurfaces: base.benchSurfaces ?? ['search'],
      search,
      ...(searchLevels ? { searchLevels } : {}),
      summary: { searchFrozenP50AvgGainPct: avgFrozenP50GainPct(search) },
    }
  }

  if (!base.indexing) {
    return { ...base, search: aggregateSearch(runs), scoreDrift: aggregateScoreDrift(runs) }
  }

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
          nodeCount: base.memoryBreakdown.radixTree.nodeCount,
          edgeCount: base.memoryBreakdown.radixTree.edgeCount,
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
  const searchLevels = aggregateSearchLevels(runs)

  return {
    id: base.id,
    name: base.name,
    documentCount: base.documentCount,
    fields: base.fields,
    storeFields: base.storeFields,
    benchSurfaces: base.benchSurfaces,
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
    ...(searchLevels ? { searchLevels } : {}),
    scoreDrift,
    summary: {
      heapFrozenVsMutableSavingPct: heapSavingPct,
      diskBinaryVsJsonSavingPct: diskSavingPct,
      loadBinaryVsJsonSavingPct: loadSavingPct,
      searchFrozenP50AvgGainPct: avgFrozenP50GainPct(search),
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
        { label: 'AND+prefix', q: 'infe para', opts: { combineWith: 'AND', prefix: true } },
        { label: 'AND+fuzzy', q: 'infern paradis', opts: { combineWith: 'AND', fuzzy: 0.2 } },
        { label: 'AND_NOT', q: 'inferno paradiso', opts: { combineWith: 'AND_NOT' } },
        { label: 'AND_NOT+prefix', q: 'infe para', opts: { combineWith: 'AND_NOT', prefix: true } },
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
        { label: 'AND+prefix', q: 'unique1 common', opts: { combineWith: 'AND', prefix: true } },
        { label: 'AND_NOT', q: 'unique1 common', opts: { combineWith: 'AND_NOT' } },
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

/** Scenarios with fixed `benchBatch` per query (from searchBenchBatches.json). */
export function buildBenchmarkScenarios () {
  return applySearchBenchBatchesToScenarios(buildScenarioList())
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
 * Search iteration counts come from `SEARCH_ITERATIONS` (env/CLI) and per-query calibration
 * (`searchIterationsForBatchEntry`); there is no per-call override.
 * @param {{ benchProfile?: 'full' | 'search' }} [benchOptions]
 */
export function runScenario (scenario, benchOptions = {}) {
  const surfaces = benchOptions.surfaces ?? [...ALL_SURFACES]
  const need = computeSurfaceNeeds(surfaces)
  const benchProfile = need.searchOnly ? 'search' : (benchOptions.benchProfile ?? 'full')
  const levelOpts = { searchLevels: need.searchLevels }

  if (need.searchOnly) {
    const { id, name, corpus, options, queries } = scenario
    const { mutableSearchIndex, frozenSearchIndex } = prepareScenarioSearchIndexes(corpus, options)
    const bench = benchScenarioSearch(
      mutableSearchIndex,
      frozenSearchIndex,
      queries,
      id,
      levelOpts,
    )
    return {
      id,
      name,
      documentCount: corpus.length,
      fields: options.fields,
      storeFields: options.storeFields || [],
      benchProfile: 'search',
      benchSurfaces: surfaces,
      search: bench.search,
      ...(bench.searchLevels ? { searchLevels: bench.searchLevels } : {}),
      summary: { searchFrozenP50AvgGainPct: bench.avgFrozenP50GainPct },
    }
  }

  const { id, name, corpus, options, queries, driftQueries } = scenario
  const needsArtifacts = need.build || need.save || need.load || need.migrate || need.drift

  let search
  let searchGain
  let searchLevels
  if (need.search) {
    const { mutableSearchIndex, frozenSearchIndex } = prepareScenarioSearchIndexes(corpus, options)
    const bench = benchScenarioSearch(
      mutableSearchIndex,
      frozenSearchIndex,
      queries,
      id,
      levelOpts,
    )
    search = bench.search
    searchGain = bench.avgFrozenP50GainPct
    searchLevels = bench.searchLevels
  }

  let json
  let binaryBuf
  let indexMs
  let freezeMs
  let fromDocumentsMs
  let jsonSerializeMs
  let binarySerializeMs

  if (needsArtifacts) {
    const ms = timedMs(() => {
      const m = new MiniSearch(options)
      m.addAll(corpus)
      return m
    })
    indexMs = ms.ms
    const ser = timedMs(() => JSON.stringify(ms.result))
    json = ser.result
    jsonSerializeMs = ser.ms
    const fr = timedMs(() => FrozenMiniSearch.fromMiniSearch(ms.result, options))
    freezeMs = fr.ms
    const bin = timedMs(() => fr.result.saveBinarySync())
    binaryBuf = bin.result
    binarySerializeMs = bin.ms
    if (need.build) {
      const direct = timedMs(() => FrozenMiniSearch.fromDocuments(corpus, options))
      fromDocumentsMs = direct.ms
    }
  }

  gc()

  let heapMutable
  let heapFrozen
  let heapBuildMutableFreeze
  let heapBuildFromDocuments
  if (need.memory || need.breakdown) {
    heapMutable = measureHeap(() => {
      const ms = new MiniSearch(options)
      ms.addAll(corpus)
      return ms
    })
    heapFrozen = measureHeap(() => {
      const ms = new MiniSearch(options)
      ms.addAll(corpus)
      return FrozenMiniSearch.fromMiniSearch(ms, options)
    })
    if (need.build) {
      heapBuildMutableFreeze = measureHeap(() => {
        const ms = new MiniSearch(options)
        ms.addAll(corpus)
        return FrozenMiniSearch.fromMiniSearch(ms, options)
      })
      heapBuildFromDocuments = measureHeap(() => FrozenMiniSearch.fromDocuments(corpus, options))
    }
  }

  let breakdown
  if (need.breakdown) {
    if (!heapFrozen) {
      heapFrozen = measureHeap(() => {
        const ms = new MiniSearch(options)
        ms.addAll(corpus)
        return FrozenMiniSearch.fromMiniSearch(ms, options)
      })
    }
    breakdown = frozenMemoryBreakdown(heapFrozen.value)
  }

  let heapJsonLoaded
  let heapBinaryLoaded
  let loadJson
  let loadBinary
  if (need.load) {
    heapJsonLoaded = measureHeap(() => MiniSearch.loadJSON(json, options))
    heapBinaryLoaded = measureHeap(() => FrozenMiniSearch.loadBinarySync(binaryBuf, options))
    gc()
    loadJson = timedMs(() => MiniSearch.loadJSON(json, options))
    gc()
    loadBinary = timedMs(() => FrozenMiniSearch.loadBinarySync(binaryBuf, options))
    gc()
  }

  const heapSavingPct = heapMutable && heapFrozen && heapMutable.heapMb > 0
    ? Number((100 * (1 - heapFrozen.heapMb / heapMutable.heapMb)).toFixed(1))
    : 0

  let scoreDrift
  if (need.drift && driftQueries && driftQueries.length > 0) {
    const ms = new MiniSearch(options)
    ms.addAll(corpus)
    const frozen = FrozenMiniSearch.fromMiniSearch(ms, options)
    scoreDrift = driftQueries.map((query) => computeScoreDrift(ms, frozen, query))
  }

  const jsonMb = json != null ? mbRound(json.length) : undefined
  const binaryMb = binaryBuf != null ? mbRound(binaryBuf.length) : undefined
  const binaryMagic = binaryBuf != null ? binaryBuf.toString('ascii', 0, 4) : undefined

  const result = {
    id,
    name,
    documentCount: corpus.length,
    fields: options.fields,
    storeFields: options.storeFields || [],
    benchSurfaces: surfaces,
    summary: {},
  }

  if (needsArtifacts && (need.build || need.save || need.migrate)) {
    result.indexing = {
      ...(need.build ? {
        addAllMs: Number(indexMs.toFixed(2)),
        fromDocumentsMs: Number(fromDocumentsMs.toFixed(2)),
      } : {}),
      ...(need.migrate ? { freezeMs: Number(freezeMs.toFixed(2)) } : {}),
      ...(need.save ? {
        jsonSerializeMs: Number(jsonSerializeMs.toFixed(2)),
        saveBinaryMs: Number(binarySerializeMs.toFixed(2)),
        binaryMagic,
      } : {}),
    }
  }

  if (need.memory && heapMutable && heapFrozen) {
    result.heapMb = {
      mutable: heapMutable.heapMb,
      frozen: heapFrozen.heapMb,
      ...(need.build && heapBuildMutableFreeze && heapBuildFromDocuments ? {
        buildMutableFreeze: heapBuildMutableFreeze.heapMb,
        buildFromDocuments: heapBuildFromDocuments.heapMb,
        buildFromDocumentsVsMutableFreezeSavingPct: heapBuildMutableFreeze.heapMb > 0
          ? Number((100 * (1 - heapBuildFromDocuments.heapMb / heapBuildMutableFreeze.heapMb)).toFixed(1))
          : 0,
      } : {}),
      ...(need.load && heapJsonLoaded && heapBinaryLoaded ? {
        loadJson: heapJsonLoaded.heapMb,
        loadBinary: heapBinaryLoaded.heapMb,
      } : {}),
      frozenVsMutableSavingPct: heapSavingPct,
    }
    result.memoryMb = {
      frozen: {
        heapUsed: heapFrozen.heapMb,
        external: heapFrozen.externalMb,
        arrayBuffers: heapFrozen.arrayBuffersMb,
        rss: heapFrozen.rssMb,
        totalResidentApprox: heapFrozen.totalResidentApproxMb,
      },
      mutable: {
        heapUsed: heapMutable.heapMb,
        external: heapMutable.externalMb,
        arrayBuffers: heapMutable.arrayBuffersMb,
        rss: heapMutable.rssMb,
        totalResidentApprox: heapMutable.totalResidentApproxMb,
      },
    }
    result.summary.heapFrozenVsMutableSavingPct = heapSavingPct
  }

  if (need.save && jsonMb != null && binaryMb != null) {
    result.diskMb = {
      json: jsonMb,
      binary: binaryMb,
      binaryVsJsonSavingPct: jsonMb > 0
        ? Number((100 * (1 - binaryMb / jsonMb)).toFixed(1))
        : 0,
    }
    result.summary.diskBinaryVsJsonSavingPct = result.diskMb.binaryVsJsonSavingPct
  }

  if (need.load && loadJson && loadBinary) {
    result.loadMs = {
      json: Number(loadJson.ms.toFixed(2)),
      binary: Number(loadBinary.ms.toFixed(2)),
      binaryVsJsonSavingPct: loadJson.ms > 0
        ? Number((100 * (1 - loadBinary.ms / loadJson.ms)).toFixed(1))
        : 0,
    }
    result.summary.loadBinaryVsJsonSavingPct = result.loadMs.binaryVsJsonSavingPct
  }

  if (need.breakdown) result.memoryBreakdown = breakdown
  if (need.search) {
    result.search = search
    result.summary.searchFrozenP50AvgGainPct = searchGain
    if (searchLevels) result.searchLevels = searchLevels
  }
  if (need.drift) result.scoreDrift = scoreDrift

  return result
}

export function runBenchmarkSuite (
  scenarios = buildBenchmarkScenarios(),
  runs = defaultBenchmarkRuns(),
  benchOptions = {},
) {
  const total = scenarios.length
  const surfaces = benchOptions.surfaces ?? [...ALL_SURFACES]
  const need = computeSurfaceNeeds(surfaces)
  const benchProfile = need.searchOnly ? 'search' : (benchOptions.benchProfile ?? 'full')
  const profileLabel = need.searchOnly ? 'search-only' : `surfaces=[${surfaces.join(',')}]`
  if (need.searchOnly) {
    console.log('Benchmark profile: search-only (skip indexing / heap / save / load timing)\n')
  } else if (surfaces.length < ALL_SURFACES.length) {
    console.log(`Benchmark surfaces: ${surfaces.join(', ')}\n`)
  }
  if (runs <= 1) {
    return scenarios.map((scenario, index) => {
      const t0 = performance.now()
      console.log(`[bench ${index + 1}/${total}] ${scenario.id} (${profileLabel}) …`)
      const result = runScenario(scenario, benchOptions)
      console.log(`[bench ${index + 1}/${total}] ${scenario.id} done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      return result
    })
  }
  return scenarios.map((scenario, index) => {
    const results = []
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now()
      console.log(`[bench ${index + 1}/${total}] ${scenario.id} run ${i + 1}/${runs} (${profileLabel}) …`)
      results.push(runScenario(scenario, benchOptions))
      console.log(
        `[bench ${index + 1}/${total}] ${scenario.id} run ${i + 1}/${runs} done in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      )
    }
    return aggregateScenarioRuns(results)
  })
}
