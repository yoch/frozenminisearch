import FrozenMiniSearch, { freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { createFrozenIndexBuilder } from './frozenBuild'
import { finalizeSearchResults } from './scoring'

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
})
