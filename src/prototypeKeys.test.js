import FrozenMiniSearch from './FrozenMiniSearch'

// Field ids and boosts live in objects without a prototype, so a field named `__proto__` behaves
// like any other. Literal `__proto__` terms and stored-field keys keep MiniSearch's per-object behaviour
// (see dev/parity/PARITY_CONTRACT.md): those cases only check that Object.prototype is untouched.
const objectPrototypeKeys = Reflect.ownKeys(Object.prototype)

afterEach(() => {
  expect(Reflect.ownKeys(Object.prototype)).toEqual(objectPrototypeKeys)
  expect({}.polluted).toBeUndefined()
})

function roundTrips(index, options) {
  return [
    index,
    FrozenMiniSearch.loadBinarySync(index.saveBinarySync(), options),
    FrozenMiniSearch.fromJSON(JSON.stringify(index), options),
  ]
}

test('an indexed field named __proto__ participates in all matching paths', () => {
  const options = { fields: ['__proto__'], searchOptions: { boost: { ['__proto__']: 2 } } }
  const source = FrozenMiniSearch.fromDocuments([{ id: 0, ['__proto__']: 'alpha' }], options)
  for (const index of roundTrips(source, options)) {
    expect(index.matchIds('alpha')).toEqual([0])
    expect(index.search('alpha')[0].match.alpha).toEqual(['__proto__'])
  }
})

test('an indexed field named __proto__ keeps its terms apart from other fields', () => {
  const options = { fields: ['title', '__proto__'] }
  const source = FrozenMiniSearch.fromDocuments([
    { id: 0, title: 'x', ['__proto__']: 'alpha' },
    { id: 1, title: 'alpha' },
  ], options)
  for (const index of roundTrips(source, options)) {
    expect(index.search('x').map(({ id, match }) => [id, match])).toEqual([[0, { x: ['title'] }]])
    expect(index.search('alpha').map(({ id, match }) => [id, match]).sort()).toEqual([[0, { alpha: ['__proto__'] }], [1, { alpha: ['title'] }]])
    expect(index.matchIds('alpha', { fields: ['__proto__'] })).toEqual([0])
  }
})

test('__proto__ terms in documents and queries', () => {
  const options = { fields: ['text'], tokenize: text => text.split(' ') }
  const source = FrozenMiniSearch.fromDocuments([
    { id: 0, text: 'alpha __proto__' },
    { id: 1, text: '__ __proto__ polluted' },
  ], options)
  for (const index of roundTrips(source, options)) {
    for (const searchOptions of [{}, { combineWith: 'AND' }, { combineWith: 'AND_NOT' }, { prefix: true }, { fuzzy: 0.3 }]) {
      for (const query of ['alpha __proto__', '__', '__proto__ polluted']) {
        index.search(query, searchOptions)
        index.search(query, { ...searchOptions, matchInfo: false })
        index.searchPage(query, { ...searchOptions, limit: 1 })
        index.matchIds(query, searchOptions)
        index.autoSuggest(query, searchOptions)
      }
    }
  }
})

test.each([[['__proto__']], [['text', '__proto__']]])('stored field named __proto__: %j', (storeFields) => {
  const options = { fields: ['text'], storeFields }
  const source = FrozenMiniSearch.fromDocuments([{ id: 0, text: 'alpha', ['__proto__']: { polluted: true } }], options)
  for (const index of roundTrips(source, options)) {
    index.search('alpha')
    index.searchPage(FrozenMiniSearch.wildcard, { limit: 1 })
    index.getStoredFields(0)
  }
})

test('untrusted snapshot rows with a __proto__ key', () => {
  const options = { fields: ['text'], storeFields: ['text', 'title'] }
  const snapshot = JSON.parse(JSON.stringify(FrozenMiniSearch.fromDocuments([{ id: 0, text: 'alpha', title: 'T' }], options)))
  snapshot.storedFields['0'] = JSON.parse('{"title":"T","__proto__":{"polluted":true}}')
  const index = FrozenMiniSearch.fromJSON(JSON.stringify(snapshot), options)
  for (const loaded of roundTrips(index, options)) {
    loaded.search('alpha')
    loaded.getStoredFields(0)
  }
})
