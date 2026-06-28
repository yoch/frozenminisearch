import { forEachLiveShortId } from './forEachLiveShortId'

describe('forEachLiveShortId', () => {
  test('visits live shortIds in order with external ids', () => {
    const seen = []
    forEachLiveShortId(4, ['a', 'b', 'c', 'd'], (shortId, externalId) => {
      seen.push([shortId, externalId])
    })
    expect(seen).toEqual([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']])
  })

  test('skips holes where externalIds[shortId] is undefined', () => {
    const seen = []
    forEachLiveShortId(4, ['a', undefined, 'c', undefined], (shortId, externalId) => {
      seen.push([shortId, externalId])
    })
    expect(seen).toEqual([[0, 'a'], [2, 'c']])
  })

  test('does not call callback when nextId is zero', () => {
    let calls = 0
    forEachLiveShortId(0, [], () => { calls += 1 })
    expect(calls).toBe(0)
  })
})
