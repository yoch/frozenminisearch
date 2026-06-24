import MiniSearch from 'minisearch'
import FrozenMiniSearch from './FrozenMiniSearch'

const docs = [
  { id: 1, title: 'Moby Dick', text: 'Call me Ishmael whale sea' },
  { id: 2, title: 'Zen Motorcycle', text: 'zen art motorcycle maintenance' },
]

const options = {
  fields: ['title', 'text'],
  storeFields: ['title'],
  searchOptions: { prefix: true },
}

describe('fromMiniSearch loaders', () => {
  test('fromJSON matches reference search', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const json = JSON.stringify(reference)
    const frozen = FrozenMiniSearch.fromJSON(json, options)
    expect(frozen.search('zen')).toEqual(reference.search('zen'))
    expect(frozen.search('ishmael', { prefix: true }).map(r => r.id)).toEqual(
      reference.search('ishmael', { prefix: true }).map(r => r.id),
    )
  })

  test('fromMiniSearch instance uses toJSON()', () => {
    const reference = new MiniSearch(options)
    reference.addAll(docs)
    const frozen = FrozenMiniSearch._fromMiniSearch(reference, options)
    expect(frozen.documentCount).toBe(reference.documentCount)
    expect(frozen.search('zen art', { combineWith: 'AND' }).length).toBeGreaterThan(0)
  })
})
