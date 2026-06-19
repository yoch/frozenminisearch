import FrozenMiniSearch, { freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { createFrozenIndexBuilder } from './frozenBuild'
import { finalizeSearchResults } from './scoring'
import { assignStoredFields } from './storedFieldsLayout'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance', category: 'fiction' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title', 'category'],
  searchOptions: { prefix: true, fuzzy: 0.2 },
}

describe('FrozenMiniSearch core', () => {
  test('fromDocuments indexes and searches', () => {
    const index = FrozenMiniSearch.fromDocuments(docs, options)
    expect(index.documentCount).toBe(2)
    expect(index.search('zen').length).toBeGreaterThan(0)
  })

  test('builder path matches fromDocuments', () => {
    const builder = createFrozenIndexBuilder(options)
    for (const doc of docs) builder.add(doc)
    const built = freezeFrozenIndexBuilder(builder)
    const direct = FrozenMiniSearch.fromDocuments(docs, options)
    expect(built.search('zen').map(r => r.id)).toEqual(direct.search('zen').map(r => r.id))
  })

  test('binary round-trip', () => {
    const frozen = FrozenMiniSearch.fromDocuments(docs, options)
    const loaded = FrozenMiniSearch.loadBinarySync(frozen.saveBinarySync(), options)
    expect(loaded.search('zen').map(r => r.id)).toEqual(frozen.search('zen').map(r => r.id))
  })

  test('rejects missing document id', () => {
    expect(() => FrozenMiniSearch.fromDocuments([{ text: 'a' }], { fields: ['text'] }))
      .toThrow(/ID/)
  })

  test('finalizeSearchResults supports no stored fields reader', () => {
    const rawResults = new Map([
      [0, { score: 2, terms: ['alpha'], match: { alpha: ['text'] } }],
      [1, { score: 1, terms: ['beta'], match: { beta: ['text'] } }],
    ])
    const seen = []
    const results = finalizeSearchResults({
      rawResults,
      getExternalId: docId => docId + 1,
      filter: (result) => {
        seen.push({
          id: result.id,
          terms: result.terms,
          queryTerms: result.queryTerms,
          match: result.match,
        })
        return result.id === 1
      },
    })

    expect(seen).toEqual([
      { id: 1, terms: ['alpha'], queryTerms: ['alpha'], match: { alpha: ['text'] } },
      { id: 2, terms: ['beta'], queryTerms: ['beta'], match: { beta: ['text'] } },
    ])
    expect(results).toEqual([
      {
        id: 1,
        score: 2,
        terms: ['alpha'],
        queryTerms: ['alpha'],
        match: { alpha: ['text'] },
      },
    ])
  })

  test('search without stored fields keeps result shape minimal', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [
        { id: 1, text: 'alpha beta', category: 'hidden' },
        { id: 2, text: 'beta gamma', category: 'hidden' },
      ],
      { fields: ['text'], storeFields: [] },
    )

    const [result] = index.search('alpha')
    expect(result).toMatchObject({
      id: 1,
      terms: ['alpha'],
      queryTerms: ['alpha'],
      match: { alpha: ['text'] },
    })
    expect(result).not.toHaveProperty('category')
  })

  test('filter without stored fields can inspect computed result fields', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [
        { id: 1, text: 'alpha beta' },
        { id: 2, text: 'beta gamma' },
      ],
      { fields: ['text'], storeFields: [] },
    )
    const inspected = []
    const results = index.search('beta', {
      filter: (result) => {
        inspected.push({
          id: result.id,
          score: typeof result.score,
          terms: result.terms,
          queryTerms: result.queryTerms,
          match: result.match,
        })
        return result.id === 2
      },
    })

    expect(inspected).toHaveLength(2)
    expect(inspected[0].score).toBe('number')
    expect(inspected[0].terms).toEqual(['beta'])
    expect(inspected[0].queryTerms).toEqual(['beta'])
    expect(inspected[0].match).toEqual({ beta: ['text'] })
    expect(results.map(r => r.id)).toEqual([2])
  })

  test('finalizeSearchResults preserves insertion order when all scores tie', () => {
    const rawResults = new Map([
      [2, { score: 1, terms: ['alpha'], match: { alpha: ['text'] } }],
      [0, { score: 1, terms: ['alpha'], match: { alpha: ['text'] } }],
      [1, { score: 1, terms: ['alpha'], match: { alpha: ['text'] } }],
    ])

    const results = finalizeSearchResults({
      rawResults,
      getExternalId: docId => docId + 1,
    })

    expect(results.map(r => r.id)).toEqual([3, 1, 2])
  })

  test('single stored field is copied without materializing missing values', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [
        { id: 1, text: 'alpha beta', category: 'fiction' },
        { id: 2, text: 'alpha gamma' },
      ],
      { fields: ['text'], storeFields: ['category'] },
    )

    const results = index.search('alpha')

    expect(results).toHaveLength(2)
    expect(results[0]).toHaveProperty('category', 'fiction')
    expect(results[1]).not.toHaveProperty('category')
  })

  test('multi stored fields are visible to filter and final results', () => {
    const index = FrozenMiniSearch.fromDocuments(
      [
        { id: 1, text: 'alpha beta', title: 'One', category: 'fiction' },
        { id: 2, text: 'alpha gamma', title: 'Two', category: 'sci-fi' },
      ],
      { fields: ['text'], storeFields: ['title', 'category'] },
    )

    const inspected = []
    const results = index.search('alpha', {
      filter: (result) => {
        inspected.push({ id: result.id, title: result.title, category: result.category })
        return result.category === 'sci-fi'
      },
    })

    expect(inspected).toEqual([
      { id: 1, title: 'One', category: 'fiction' },
      { id: 2, title: 'Two', category: 'sci-fi' },
    ])
    expect(results.map(r => ({ id: r.id, title: r.title, category: r.category }))).toEqual([
      { id: 2, title: 'Two', category: 'sci-fi' },
    ])
  })

  test('assignStoredFields skips undefined single-column values', () => {
    const target = { id: 1 }
    assignStoredFields({ kind: 'single', field: 'category', values: [] }, 0, target)
    expect(target).toEqual({ id: 1 })
  })
})
