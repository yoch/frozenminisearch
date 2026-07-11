import { describe, expect, test } from 'vitest'
import { packSearchableMapEntries } from '../../testSupport/upstreamSearchableMap.js'
import { packedRadixVisitFuzzyRefs } from './fuzzy'

describe('fuzzy scratch workspace', () => {
  test('scratch reuse matches fresh-allocation visit counts and distances', () => {
    const tree = packSearchableMapEntries([
      ['doliprane', 0],
      ['dolipran', 1],
      ['paracetamol', 2],
      ['ibuprofene', 3],
    ])
    const collect = (scratch) => {
      const hits = []
      packedRadixVisitFuzzyRefs(tree, 'doliprane', 1, (termIndex, length, distance) => {
        hits.push(`${termIndex}:${length}:${distance}`)
      }, scratch)
      return hits.sort()
    }
    const scratch = {}
    expect(collect(scratch)).toEqual(collect())
    expect(collect(scratch)).toEqual(collect())
  })
})
