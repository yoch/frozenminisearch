import FrozenMiniSearch, { freezeFrozenIndexBuilder } from './FrozenMiniSearch'
import { createFrozenIndexBuilder } from './frozenBuild'
import { packTermsFromList } from './PackedRadixTree/packTermList'
import { IncrementalPostingsAccumulator } from './incrementalPostings'

function expectReleasedBuilder(builder) {
  expect(builder._terms).toEqual([])
  expect(builder._termIndex.size).toBe(0)
  expect(builder._externalIds).toEqual([])
  expect(builder._storedFields).toEqual({ kind: 'single', field: 'payload', values: [] })
  expect(builder._fieldLengthData).toEqual([])
  expect(builder._avgFieldLength).toEqual([])
  expect(builder._fieldTermFreqScratch.size).toBe(0)
  expect(builder._rawTokenScratch.size).toBe(0)
  expect(builder._tokenScratch).toEqual([])
  expect(builder._seenIds).toBeUndefined()
}

test('failed radix packing releases documents and stored payloads from an unusable builder', () => {
  const builder = createFrozenIndexBuilder({ fields: ['text'], storeFields: ['payload'] })
  builder.add({ id: 'one', text: 'x'.repeat(65536), payload: new Uint8Array(1024 * 1024) })
  expect(() => freezeFrozenIndexBuilder(builder)).toThrow('edge label too long')
  expectReleasedBuilder(builder)
  expect(() => builder.add({ id: 'two', text: 'valid' })).toThrow('cannot add after freezeParams')
})

test('failed posting finalization also releases growable columns', () => {
  const builder = createFrozenIndexBuilder({ fields: ['text'], storeFields: ['payload'] })
  builder.add({ id: 'one', text: 'alpha beta', payload: { retained: true } })
  const failure = new Error('posting finalization failed')
  const release = vi.spyOn(IncrementalPostingsAccumulator.prototype, 'release')
  vi.spyOn(IncrementalPostingsAccumulator.prototype, 'finalize').mockImplementationOnce(() => { throw failure })
  expect(() => freezeFrozenIndexBuilder(builder)).toThrow(failure)
  expectReleasedBuilder(builder)
  expect(release).toHaveBeenCalledOnce()
  vi.restoreAllMocks()
})

test.each([false, true])('prefix traversal releases its query reference on exit (throw=%s)', (throws) => {
  const tree = packTermsFromList(['paracetamol', 'paracetamols'])
  let cursor
  const visit = () => tree.visitPrefixRefs('parace', (_term, _length, path) => {
    cursor = path
    expect(path.term()).toMatch(/^paracetamol/)
    if (throws) throw new Error('visitor failed')
  })
  if (throws) expect(visit).toThrow('visitor failed')
  else visit()
  expect(cursor.base).toBe('')
  expect(cursor.depth).toBe(0)
  expect(cursor.inUse).toBe(false)
})

test('reentrant searches preserve the outer path and release it after a callback error', () => {
  const index = FrozenMiniSearch.fromDocuments([
    { id: 0, text: 'paracetamol' }, { id: 1, text: 'paracetamols' },
  ], { fields: ['text'] })
  const expected = index.search('parace', { prefix: true })
  expect(() => index.search('parace', {
    prefix: true,
    boostDocument() {
      expect(index.search('parace', { prefix: true })).toEqual(expected)
      throw new Error('callback failed')
    },
  })).toThrow('callback failed')
  expect(index._activeQueries).toBe(0)
  expect(index._index.termPaths.shared.base).toBe('')
  expect(index.search('parace', { prefix: true })).toEqual(expected)
})

test.each(['success', 'failure'])('finished builders drop ingestion callbacks (%s)', (outcome) => {
  const extractField = (document, field) => document[field]
  const stringifyField = value => String(value)
  const tokenize = text => [text]
  const processTerm = term => term.toLowerCase()
  const options = { fields: ['text'], extractField, stringifyField, tokenize, processTerm }
  const builder = createFrozenIndexBuilder(options)
  builder.add({ id: 0, text: outcome === 'failure' ? 'x'.repeat(65536) : 'PARACETAMOL' })
  if (outcome === 'failure') expect(() => freezeFrozenIndexBuilder(builder)).toThrow('edge label too long')
  else {
    const index = freezeFrozenIndexBuilder(builder)
    expect(index._options.extractField).not.toBe(extractField)
    expect(index._options.stringifyField).not.toBe(stringifyField)
    // These two callbacks are still needed by subsequent searches.
    expect(index._options.tokenize).toBe(tokenize)
    expect(index._options.processTerm).toBe(processTerm)
    expect(index.search('PARACETAMOL').map(hit => hit.id)).toEqual([0])
  }
  for (const callback of ['extractField', 'stringifyField', 'tokenize', 'processTerm']) {
    expect(builder._options[callback]).not.toBe(options[callback])
  }
  expect(options.extractField).toBe(extractField)
})

test('binary and JSON imports also discard unused ingestion callbacks', async () => {
  const source = FrozenMiniSearch.fromDocuments([{ id: 0, text: 'paracetamol' }], { fields: ['text'] })
  const extractField = () => { throw new Error('ingestion must not run') }
  const stringifyField = extractField
  const options = { fields: ['text'], extractField, stringifyField }
  const wire = source.saveBinarySync()
  for (const index of [
    FrozenMiniSearch.loadBinarySync(wire, options),
    await FrozenMiniSearch.loadBinaryAsync(wire, options),
    FrozenMiniSearch.fromJSON(JSON.stringify(source), options),
  ]) {
    expect(index._options.extractField).not.toBe(extractField)
    expect(index._options.stringifyField).not.toBe(stringifyField)
    expect(index.search('paracetamol').map(hit => hit.id)).toEqual([0])
  }
})
