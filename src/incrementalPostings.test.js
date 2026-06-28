import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MiniSearch from 'minisearch'
import FrozenMiniSearch, { freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { frozenFromMiniSearch, frozenMemoryBreakdown } from './internal/frozenInternals'
import { createFrozenIndexBuilder } from './frozenBuild'
import { IncrementalPostingsAccumulator } from './incrementalPostings'
import {
  createFrozenFieldTermFlyweight,
  materializeFrozenPostings,
  validateFrozenPostingsLayout,
} from './frozenPostings'
import { readDocId } from './compactPostings'

/** Each (term, field) slot occupies one contiguous [offset, offset+length) in global SoA buffers. */
function assertSegmentsPartitionBuffers(layout) {
  expect(layout.allDocIds.length).toBe(layout.allFreqs.length)

  if (layout.layout === 'dense') {
    const slotCount = layout.termCount * layout.fieldCount
    let write = 0
    for (let slot = 0; slot < slotCount; slot++) {
      expect(layout.denseOffsets[slot]).toBe(write)
      write += layout.denseLengths[slot]
    }
    expect(write).toBe(layout.allDocIds.length)
    return
  }

  let write = 0
  for (let i = 0; i < layout.sparseOffsets.length; i++) {
    expect(layout.sparseOffsets[i]).toBe(write)
    write += layout.sparseLengths[i]
  }
  expect(write).toBe(layout.allDocIds.length)
}

/** Hot path: flyweight segment is a single sequential scan over allDocIds[offset+i]. */
function assertHotPathSequentialAccess(layout, termIndex, fieldId) {
  const fly = createFrozenFieldTermFlyweight(layout).bind(termIndex)
  const seg = fly.get(fieldId)
  if (seg == null) return
  const walked = []
  seg.forEachDoc((docId, freq) => walked.push({ docId, freq }))
  expect(seg.length).toBe(walked.length)
  for (let i = 0; i < seg.length; i++) {
    expect(readDocId(seg.docIds, seg.offset + i)).toBe(walked[i].docId)
    expect(seg.freqs[seg.offset + i]).toBe(walked[i].freq)
  }
}

function layoutsEqual(a, b) {
  expect(a.fieldCount).toBe(b.fieldCount)
  expect(a.termCount).toBe(b.termCount)
  expect(a.nextId).toBe(b.nextId)
  expect(a.layout).toBe(b.layout)
  expect(a.docIdWidth).toBe(b.docIdWidth)
  if (a.layout === 'sparse') {
    expect(a.sparseFieldIdWidth).toBe(b.sparseFieldIdWidth)
  }
  expect(a.allDocIds.length).toBe(b.allDocIds.length)
  expect(a.allFreqs.length).toBe(b.allFreqs.length)
  for (let i = 0; i < a.allDocIds.length; i++) {
    expect(readDocId(a.allDocIds, i)).toBe(readDocId(b.allDocIds, i))
    expect(a.allFreqs[i]).toBe(b.allFreqs[i])
  }
  if (a.layout === 'dense') {
    expect(Array.from(a.denseOffsets)).toEqual(Array.from(b.denseOffsets))
    expect(Array.from(a.denseLengths)).toEqual(Array.from(b.denseLengths))
  } else {
    expect(Array.from(a.sparseTermStarts)).toEqual(Array.from(b.sparseTermStarts))
    expect(Array.from(a.sparseFieldIds)).toEqual(Array.from(b.sparseFieldIds))
    expect(Array.from(a.sparseOffsets)).toEqual(Array.from(b.sparseOffsets))
    expect(Array.from(a.sparseLengths)).toEqual(Array.from(b.sparseLengths))
  }
}

function buildCallback(fieldCount, postings, nextId = 100) {
  const termCount = postings.reduce((m, p) => Math.max(m, p.termIndex + 1), 0)
  return materializeFrozenPostings({
    fieldCount,
    termCount,
    nextId,
    forEachPosting(termIndex, fieldId, emit) {
      for (const posting of postings) {
        if (posting.termIndex === termIndex && posting.fieldId === fieldId) {
          emit(posting.docId, posting.freq)
        }
      }
    },
    clampFrequencies: true,
  })
}

function buildIncremental(fieldCount, postings, nextId = 100) {
  const acc = new IncrementalPostingsAccumulator(fieldCount)
  for (const { termIndex, fieldId, docId, freq } of postings) {
    acc.append(termIndex, fieldId, docId, freq)
  }
  const termCount = postings.reduce((m, p) => Math.max(m, p.termIndex + 1), 0)
  return acc.finalize(termCount, nextId)
}

describe('IncrementalPostingsAccumulator', () => {
  test('dense layout matches legacy materialize', () => {
    const postings = [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 2 },
      { termIndex: 0, fieldId: 0, docId: 3, freq: 1 },
      { termIndex: 1, fieldId: 0, docId: 0, freq: 4 },
      { termIndex: 1, fieldId: 0, docId: 2, freq: 1 },
    ]
    const layout = buildIncremental(1, postings)
    expect(layout.layout).toBe('dense')
    layoutsEqual(layout, buildCallback(1, postings))
  })

  test('sparse layout matches legacy materialize when sparse is cheaper', () => {
    const postings = [
      { termIndex: 0, fieldId: 0, docId: 1, freq: 1 },
      { termIndex: 0, fieldId: 2, docId: 1, freq: 3 },
      { termIndex: 1, fieldId: 1, docId: 0, freq: 2 },
      { termIndex: 1, fieldId: 3, docId: 4, freq: 1 },
      { termIndex: 2, fieldId: 0, docId: 2, freq: 5 },
    ]
    const layout = buildIncremental(4, postings)
    expect(layout.layout).toBe('sparse')
    layoutsEqual(layout, buildCallback(4, postings))
  })

  test('multi-field dense layout is selected when dense metadata is cheaper', () => {
    const postings = []
    for (let termIndex = 0; termIndex < 3; termIndex++) {
      for (let fieldId = 0; fieldId < 4; fieldId++) {
        postings.push({ termIndex, fieldId, docId: termIndex, freq: fieldId + 1 })
      }
    }
    const layout = buildIncremental(4, postings)
    expect(layout.layout).toBe('dense')
    layoutsEqual(layout, buildCallback(4, postings))
    validateFrozenPostingsLayout(layout, 100, 100)
    assertSegmentsPartitionBuffers(layout)
    assertHotPathSequentialAccess(layout, 1, 2)
  })

  test('interleaved appends per slot preserve order', () => {
    const postings = [
      { termIndex: 0, fieldId: 1, docId: 0, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 1, freq: 2 },
      { termIndex: 0, fieldId: 1, docId: 2, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 3, freq: 1 },
    ]
    layoutsEqual(buildIncremental(3, postings), buildCallback(3, postings))
  })

  test('flat materialization chooses the same dense multi-field layout', () => {
    const postings = []
    for (let termIndex = 0; termIndex < 3; termIndex++) {
      for (let fieldId = 0; fieldId < 4; fieldId++) {
        postings.push({ termIndex, fieldId, docId: termIndex, freq: fieldId + 1 })
      }
    }
    const flat = materializeFrozenPostings({
      fieldCount: 4,
      termCount: 3,
      nextId: 100,
      forEachPosting(termIndex, fieldId, emit) {
        for (const posting of postings) {
          if (posting.termIndex === termIndex && posting.fieldId === fieldId) {
            emit(posting.docId, posting.freq)
          }
        }
      },
      clampFrequencies: true,
    })
    expect(flat.layout).toBe('dense')
    layoutsEqual(flat, buildIncremental(4, postings))
  })

  test('fromMiniSearch and incremental builder choose the same dense layout', () => {
    const fields = ['f0', 'f1', 'f2', 'f3']
    const documents = Array.from({ length: 4 }, (_, id) => ({
      id,
      f0: `term${id} common`,
      f1: `term${id} common`,
      f2: `term${id} common`,
      f3: `term${id} common`,
    }))
    const options = { fields, storeFields: [] }
    const mutable = new MiniSearch(options)
    mutable.addAll(documents)

    const fromMiniSearch = frozenFromMiniSearch(FrozenMiniSearch, mutable, options)
    const fromDocuments = FrozenMiniSearch.fromDocuments(documents, options)

    expect(frozenMemoryBreakdown(fromMiniSearch).postings.layout).toBe('dense')
    expect(frozenMemoryBreakdown(fromDocuments).postings.layout).toBe('dense')
    expect(searchSnapshot(fromDocuments, 'term2')).toEqual(searchSnapshot(fromMiniSearch, 'term2'))
  })

  test('non-contiguous scratch ranges compact to one hot-path segment', () => {
    const acc = new IncrementalPostingsAccumulator(1)
    acc.append(0, 0, 1, 1)
    acc.append(0, 0, 3, 2)
    acc.append(1, 0, 0, 1) // other slot between same-slot appends
    acc.append(0, 0, 5, 1)
    const layout = acc.finalize(2, 10)
    validateFrozenPostingsLayout(layout, 10, 10)
    assertSegmentsPartitionBuffers(layout)
    assertHotPathSequentialAccess(layout, 0, 0)
    const fly = createFrozenFieldTermFlyweight(layout).bind(0)
    const seg = fly.get(0)
    expect(seg.length).toBe(3)
    const docIds = []
    seg.forEachDoc(docId => docIds.push(docId))
    expect(docIds).toEqual([1, 3, 5])
  })

  test('interleaved scratch compacts to contiguous hot-path segments (sparse)', () => {
    const postings = [
      { termIndex: 0, fieldId: 1, docId: 0, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 1, freq: 2 },
      { termIndex: 0, fieldId: 1, docId: 2, freq: 1 },
      { termIndex: 5, fieldId: 0, docId: 3, freq: 1 },
    ]
    const layout = buildIncremental(3, postings)
    validateFrozenPostingsLayout(layout, 100, 100)
    assertSegmentsPartitionBuffers(layout)
    assertHotPathSequentialAccess(layout, 0, 1)
    assertHotPathSequentialAccess(layout, 5, 0)
  })

  test('uint16 doc ids when nextId fits', () => {
    const layout = buildIncremental(1, [{ termIndex: 0, fieldId: 0, docId: 65534, freq: 1 }], 65535)
    expect(layout.docIdWidth).toBe(16)
  })

  test('uint32 doc ids when nextId exceeds 65535', () => {
    const layout = buildIncremental(1, [{ termIndex: 0, fieldId: 0, docId: 70000, freq: 1 }], 70001)
    expect(layout.docIdWidth).toBe(32)
  })
})

function buildIncrementally(documents, options) {
  const builder = createFrozenIndexBuilder(options, { estimatedDocumentCount: documents.length })
  for (const doc of documents) builder.add(doc)
  return freezeFrozenIndexBuilder(builder)
}

function buildDocByDoc(documents, options) {
  const builder = createFrozenIndexBuilder(options)
  for (const doc of documents) builder.add(doc)
  return freezeFrozenIndexBuilder(builder)
}

function searchSnapshot(index, query) {
  return index.search(query).map(r => ({ id: r.id, score: r.score }))
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../testSupport/fixtures')
const DEFAULT_MEDICAMENTS_CORPUS_DIR = '/home/yoch/fr.gouv.medicaments.rest/data/corpus-export'

function parseJsonl(content) {
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

function loadJsonlFile(dir, file) {
  return parseJsonl(readFileSync(join(dir, file), 'utf8'))
}

function registerGoldenDatasetTests({ id, documents, options, query }) {
  test(`${id} doc-by-doc add matches hinted incremental build`, () => {
    const hinted = buildIncrementally(documents, options)
    const docByDoc = buildDocByDoc(documents, options)

    expect(docByDoc.termCount).toBe(hinted.termCount)
    expect(docByDoc.documentCount).toBe(hinted.documentCount)
    expect(searchSnapshot(docByDoc, query)).toEqual(searchSnapshot(hinted, query))

    const builder = createFrozenIndexBuilder(options)
    for (const doc of documents) builder.add(doc)
    const params = builder.freezeParams()
    validateFrozenPostingsLayout(params.postings, params.documentCount, params.nextId)
    assertSegmentsPartitionBuffers(params.postings)
  })

  test(`${id} incremental build round-trips through binary`, () => {
    const built = buildDocByDoc(documents, options)
    const loaded = FrozenMiniSearch.loadBinarySync(built.saveBinarySync(), options)

    expect(loaded.termCount).toBe(built.termCount)
    expect(searchSnapshot(loaded, query)).toEqual(searchSnapshot(built, query))
  })
}

describe('IncrementalPostingsAccumulator golden (CI fixture)', () => {
  const fixtureDataset = {
    id: 'incremental-golden',
    file: 'incremental-golden.jsonl',
    options: {
      fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
      storeFields: ['id'],
    },
    query: 'doliprane',
  }
  const documents = loadJsonlFile(FIXTURES_DIR, fixtureDataset.file)
  registerGoldenDatasetTests({ ...fixtureDataset, documents })

  test('fromAsyncIterable matches doc-by-doc incremental build', async () => {
    const { default: FrozenMiniSearch } = await import('./FrozenMiniSearch')
    const options = { fields: ['txt'], storeFields: [] }
    const streamDocs = [
      { id: 'a', txt: 'alpha beta gamma' },
      { id: 'b', txt: 'beta delta' },
      { id: 'c', txt: 'gamma epsilon' },
    ]

    async function* stream() {
      for (const doc of streamDocs) yield doc
    }

    const fromStream = await FrozenMiniSearch.fromAsyncIterable(stream(), options, {
      estimatedDocumentCount: streamDocs.length,
    })
    const fromAdds = buildDocByDoc(streamDocs, options)

    expect(fromStream.termCount).toBe(fromAdds.termCount)
    expect(searchSnapshot(fromStream, 'beta')).toEqual(searchSnapshot(fromAdds, 'beta'))
  })
})

describe('IncrementalPostingsAccumulator medicaments golden (optional local)', () => {
  const corpusDir = process.env.CORPUS_EXPORT_DIR ?? DEFAULT_MEDICAMENTS_CORPUS_DIR

  const datasets = [
    {
      id: 'bdpm-generiques',
      file: 'bdpm_generiques.jsonl',
      options: { fields: ['libelle_groupe'], storeFields: ['id'] },
      query: 'cimetidine',
    },
    {
      id: 'bdpm-substances',
      file: 'bdpm_substances.jsonl',
      options: { fields: ['denomination'], storeFields: ['id'] },
      query: 'paracetamol',
    },
    {
      id: 'bdpm-specialites',
      file: 'bdpm_specialites.jsonl',
      options: {
        fields: ['cis', 'denomination', 'forme_pharma', 'titulaire'],
        storeFields: ['id'],
      },
      query: 'doliprane',
    },
    {
      id: 'bdpm-presentations',
      file: 'bdpm_presentations.jsonl',
      options: {
        fields: ['cis', 'cip7', 'cip13', 'libelle', 'indications'],
        storeFields: ['id'],
      },
      query: 'comprime',
    },
  ]

  for (const { id, file, options, query } of datasets) {
    const corpusPath = join(corpusDir, file)
    if (!existsSync(corpusPath)) {
      test.skip(`${id} doc-by-doc add matches hinted incremental build`, () => {})
      test.skip(`${id} incremental build round-trips through binary`, () => {})
      continue
    }
    const documents = loadJsonlFile(corpusDir, file)
    registerGoldenDatasetTests({ id, documents, options, query })
  }
})
