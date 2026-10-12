import FrozenMiniSearch from './FrozenMiniSearch'

test.each(['OR', 'AND'])('combining %s matches preserves a literal __proto__ term', (combineWith) => {
  const index = FrozenMiniSearch.fromDocuments([{ id: 0, text: 'alpha __proto__' }], {
    fields: ['text'], tokenize: text => text.split(' '),
  })
  const [hit] = index.search('alpha __proto__', { combineWith })
  expect(hit.terms).toEqual(['alpha', '__proto__'])
  expect(Object.getPrototypeOf(hit.match)).toBe(Object.prototype)
  expect(Object.hasOwn(hit.match, '__proto__')).toBe(true)
  expect(Object.getOwnPropertyDescriptor(hit.match, '__proto__').value).toEqual(['text'])
  expect(index.autoSuggest('alpha __proto__')[0].suggestion).toBe('alpha __proto__')
})

test('prefix accumulation preserves __proto__ after an exact match', () => {
  const index = FrozenMiniSearch.fromDocuments([{ id: 0, text: '__ __proto__' }], {
    fields: ['text'], tokenize: text => text.split(' '),
  })
  const [hit] = index.search('__', { prefix: true })
  expect(hit.terms).toEqual(['__', '__proto__'])
  expect(Object.getPrototypeOf(hit.match)).toBe(Object.prototype)
  expect(Object.getOwnPropertyDescriptor(hit.match, '__proto__').value).toEqual(['text'])
})

test.each([{ storeFields: ['__proto__'] }, { storeFields: ['text', '__proto__'] }])('stored keys survive binary and JSON round trips: $storeFields', ({ storeFields }) => {
  const payload = { retained: 'value' }
  const options = { fields: ['text'], storeFields }
  const source = FrozenMiniSearch.fromDocuments([{ id: 0, text: 'alpha', ['__proto__']: payload }], options)
  for (const index of [source, FrozenMiniSearch.loadBinarySync(source.saveBinarySync(), options), FrozenMiniSearch.fromJSON(JSON.stringify(source), options)]) {
    for (const hit of [index.search('alpha')[0], index.searchPage(FrozenMiniSearch.wildcard, { limit: 1 }).results[0]]) {
      expect(Object.getPrototypeOf(hit)).toBe(Object.prototype)
      expect(Object.hasOwn(hit, '__proto__')).toBe(true)
      expect(Object.getOwnPropertyDescriptor(hit, '__proto__').value).toEqual(payload)
    }
  }
})

test('an indexed field named __proto__ participates in all matching paths', () => {
  const options = { fields: ['__proto__'], searchOptions: { boost: { ['__proto__']: 2 } } }
  const source = FrozenMiniSearch.fromDocuments([{ id: 0, ['__proto__']: 'alpha' }], options)
  for (const index of [source, FrozenMiniSearch.loadBinarySync(source.saveBinarySync(), options), FrozenMiniSearch.fromJSON(JSON.stringify(source), options)]) {
    expect(index.matchIds('alpha')).toEqual([0])
    expect(index.search('alpha')[0].match.alpha).toEqual(['__proto__'])
  }
})
