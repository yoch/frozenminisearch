import MiniSearch from './MiniSearch'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea ocean', category: 'fiction' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance road', category: 'fiction' },
  { id: 3, title: 'Neuromancer', text: 'cyberspace matrix hacker neural', category: 'sci-fi' },
  { id: 4, title: 'Zen Archery', text: 'zen archery art practice bow', category: 'non-fiction' },
  { id: 5, title: 'Ocean Life', text: 'whale dolphin ocean marine biology', category: 'science' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title', 'category'],
  searchOptions: { prefix: true, fuzzy: 0.2 },
}

function buildEngines() {
  const mutable = new MiniSearch(options)
  mutable.addAll(docs)
  const frozen = mutable.freeze()
  return { mutable, frozen }
}

function expectSameResults(mutable, frozen, query, searchOptions = {}) {
  const a = mutable.search(query, searchOptions)
  const b = frozen.search(query, searchOptions)
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) {
    expect(b[i].id).toBe(a[i].id)
    expect(b[i].score).toBeCloseTo(a[i].score, 6)
    expect(b[i].terms).toEqual(a[i].terms)
    expect(b[i].match).toEqual(a[i].match)
    expect(b[i].queryTerms).toEqual(a[i].queryTerms)
  }
}

describe('Gate docId scoring (AND / AND_NOT)', () => {
  let mutable
  let frozen

  beforeEach(() => {
    ({ mutable, frozen } = buildEngines())
  })

  describe('AND combinations', () => {
    test.each([
      ['exact+exact', 'zen art', { combineWith: 'AND' }],
      ['exact+prefix', 'zen arch', { combineWith: 'AND', prefix: true }],
      ['exact+fuzzy', 'zen artry', { combineWith: 'AND', fuzzy: 0.3 }],
      ['prefix+fuzzy', 'neur neurmanc', { combineWith: 'AND', prefix: true, fuzzy: 0.3 }],
      ['3 terms', 'zen art motorcycle', { combineWith: 'AND' }],
    ])('%s', (_label, query, opts) => {
      expectSameResults(mutable, frozen, query, opts)
    })
  })

  describe('AND_NOT combinations', () => {
    test.each([
      ['left exact', 'zen art', { combineWith: 'AND_NOT' }],
      ['left prefix', 'zen arch', { combineWith: 'AND_NOT', prefix: true }],
      ['left fuzzy', 'zen artry', { combineWith: 'AND_NOT', fuzzy: 0.3 }],
      ['right prefix excluded', 'whale oce', { combineWith: 'AND_NOT', prefix: true }],
      ['right fuzzy excluded', 'whale oceon', { combineWith: 'AND_NOT', fuzzy: 0.3 }],
    ])('%s', (_label, query, opts) => {
      expectSameResults(mutable, frozen, query, opts)
    })
  })

  describe('nested combinations', () => {
    test('AND containing OR', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'AND',
        queries: [
          'zen',
          { combineWith: 'OR', queries: ['motorcycle', 'archery'] },
        ],
      })
    })

    test('OR containing AND (inner AND gated)', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'OR',
        queries: [
          { combineWith: 'AND', queries: ['zen', 'art'] },
          'whale',
        ],
      })
    })

    test('AND_NOT with nested negated OR', () => {
      expectSameResults(mutable, frozen, {
        combineWith: 'AND_NOT',
        queries: [
          'zen',
          { combineWith: 'OR', queries: ['motorcycle', 'ocean'] },
        ],
      })
    })
  })

  describe('with boostDocument', () => {
    const boostDocument = (id, term) => (id === 2 || term === 'archery' ? 2 : 1)

    test('AND with boostDocument', () => {
      expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND', boostDocument })
    })

    test('AND_NOT with boostDocument', () => {
      expectSameResults(mutable, frozen, 'zen art', { combineWith: 'AND_NOT', boostDocument })
    })
  })

  describe('non-regression OR and exact', () => {
    test('OR unchanged', () => {
      expectSameResults(mutable, frozen, 'zen whale', { combineWith: 'OR' })
    })

    test('exact single term unchanged', () => {
      expectSameResults(mutable, frozen, 'zen')
    })

    test('prefix single term unchanged', () => {
      expectSameResults(mutable, frozen, 'neur', { prefix: true })
    })
  })

  describe('lazy materialization (frozen only)', () => {
    test('AND resolves fewer derived terms than OR when gate is selective', () => {
      const bigDocs = []
      for (let i = 0; i < 100; i++) {
        bigDocs.push({
          id: i,
          text: i < 3 ? `zen item${i}` : `unique${i} alpha beta`,
        })
      }
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: true } })
      ms.addAll(bigDocs)

      const patchCounter = (frozen) => {
        let count = 0
        const index = frozen._index
        const original = index.termByIndex.bind(index)
        index.termByIndex = (termIndex) => {
          count++
          return original(termIndex)
        }
        return () => count
      }

      const frozenAnd = ms.freeze()
      const getAndCount = patchCounter(frozenAnd)
      frozenAnd.search('zen uniq', { combineWith: 'AND', prefix: true })
      const andResolves = getAndCount()

      const frozenOr = ms.freeze()
      const getOrCount = patchCounter(frozenOr)
      frozenOr.search('zen uniq', { combineWith: 'OR', prefix: true })
      const orResolves = getOrCount()

      expect(andResolves).toBeLessThan(orResolves)
    })

    test('AND_NOT does not resolve negated branch prefix terms', () => {
      const bigDocs = []
      for (let i = 0; i < 50; i++) {
        bigDocs.push({
          id: i,
          text: i < 2 ? 'zen alpha' : `exclude${i} beta gamma`,
        })
      }
      const ms = new MiniSearch({ fields: ['text'], searchOptions: { prefix: true } })
      ms.addAll(bigDocs)
      const frozen = ms.freeze()

      let resolveCount = 0
      const index = frozen._index
      const original = index.termByIndex.bind(index)
      index.termByIndex = (termIndex) => {
        resolveCount++
        return original(termIndex)
      }

      frozen.search('zen exclude', { combineWith: 'AND_NOT', prefix: true })

      // Positive branch may resolve zen-derived prefix terms; negated exclude* branch must not.
      expect(resolveCount).toBeLessThan(50)
    })
  })
})
