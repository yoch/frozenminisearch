import { accessSync } from 'node:fs'
import { join } from 'node:path'

const bundlePath = join(__dirname, '../../dist/browser/index.js')

beforeAll(() => {
  try {
    accessSync(bundlePath)
  } catch {
    throw new Error('dist/browser/index.js not found — run yarn build before yarn test:browser')
  }
})

describe('browser bundle smoke', () => {
  let NodeFrozenMiniSearch
  let FrozenMiniSearch
  let createFrozenIndexBuilder
  let freezeFrozenIndexBuilder

  beforeAll(async () => {
    NodeFrozenMiniSearch = (await import('../../dist/es/index.js')).default
    const mod = await import(bundlePath)
    FrozenMiniSearch = mod.default
    createFrozenIndexBuilder = mod.createFrozenIndexBuilder
    freezeFrozenIndexBuilder = mod.freezeFrozenIndexBuilder
  })

  const documents = [
    { id: '1', title: 'Moby Dick', text: 'Call me Ishmael', category: 'fiction' },
    { id: '2', title: 'Zen', text: 'Zen and the art of motorcycle maintenance', category: 'nonfiction' },
    { id: '3', title: 'Don Quixote', text: 'Somewhere in La Mancha', category: 'fiction' },
    { id: '4', title: 'Zen stories', text: 'Fictional zen art', category: 'fiction' },
  ]

  const options = { fields: ['title', 'text'], storeFields: ['title', 'category'] }

  test('fromDocuments + search + autoSuggest', () => {
    const index = FrozenMiniSearch.fromDocuments(documents, options)

    const hits = index.search('ishmael', { prefix: true })
    expect(hits.map(h => h.id)).toEqual(['1'])

    const suggestions = index.autoSuggest('zen ar')
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.some(s => s.terms.includes('zen'))).toBe(true)

    expect(index.has('2')).toBe(true)
    expect(index.getStoredFields('1')).toEqual({ title: 'Moby Dick', category: 'fiction' })
  })

  test('search options match the Node entry on the browser bundle', () => {
    const browserIndex = FrozenMiniSearch.fromDocuments(documents, options)
    const nodeIndex = NodeFrozenMiniSearch.fromDocuments(documents, options)
    const searches = [
      ['prefix', 'qui', { prefix: true }],
      ['fuzzy', 'ishmal', { fuzzy: 0.3 }],
      ['field boost', 'zen', { boost: { title: 2 } }],
      ['filter', 'zen', { filter: result => result.category === 'fiction' }],
      ['boostDocument', 'zen', { boostDocument: id => (id === '4' ? 3 : 1) }],
    ]

    for (const [, query, searchOptions] of searches) {
      expect(browserIndex.search(query, searchOptions)).toEqual(nodeIndex.search(query, searchOptions))
    }
  })

  test('fromJson round-trip search', () => {
    const built = FrozenMiniSearch.fromDocuments(documents, options)
    const loaded = FrozenMiniSearch.fromJson(JSON.stringify(built), options)
    const hits = loaded.search('quixote', { prefix: true })
    expect(hits.map(h => h.id)).toEqual(['3'])
  })

  test('incremental builder', () => {
    const builder = createFrozenIndexBuilder(options)
    for (const doc of documents) builder.add(doc)
    const index = freezeFrozenIndexBuilder(builder)
    expect(index.search('moby').map(h => h.id)).toEqual(['1'])
  })
})
