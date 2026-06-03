import SearchableMap from '../SearchableMap/SearchableMap'
import {
  buildFuzzySweepQueries,
  collectTerms,
  planSweepSize,
} from '../../testSupport/fuzzyQueryMutations.js'
import { sortedFuzzyTuples, sortedMapFuzzy } from '../../testSupport/fuzzyParity.js'
import { fromRadixTree } from './index'

const PARITY_SEED = 0x50415249 // 'PARI'

function buildIndexFromTerms (terms) {
  const map = SearchableMap.from(terms.map((term, i) => [term, i]))
  const packed = fromRadixTree(map.radixTree, map.size)
  return { map, packed, terms: collectTerms(packed) }
}

function assertSweepParity ({ map, packed, terms, termSample }) {
  const cases = buildFuzzySweepQueries({
    terms,
    termSample,
    seed: PARITY_SEED,
    includeDoubleEdits: true,
  })
  const plan = planSweepSize({ termCount: termSample, includeDoubleEdits: true })
  const expectedMax = termSample * plan.mutationsPerTerm
  expect(cases.length).toBeGreaterThan(expectedMax * 0.95)
  expect(cases.length).toBeLessThanOrEqual(expectedMax)

  for (const { query, maxDistance } of cases) {
    const fromPacked = sortedFuzzyTuples(
      Array.from(packed.fuzzyRefs(query, maxDistance))
        .map(({ termIndex, distance }) => [packed.termByIndex(termIndex), termIndex, distance]),
    )
    const fromMap = sortedMapFuzzy(map.fuzzyGet(query, maxDistance))
    expect(fromMap).toEqual(fromPacked)
  }

  return { caseCount: cases.length }
}

describe('fuzzy sweep parity (packed vs SearchableMap)', () => {
  const smallTerms = ['summer', 'acqua', 'aqua', 'acquire', 'poisson', 'qua', 'virtute', 'doliprane']

  it('matches on the small fixed corpus (~250 sweep queries)', () => {
    const { map, packed, terms } = buildIndexFromTerms(smallTerms)
    const { caseCount } = assertSweepParity({
      map,
      packed,
      terms,
      termSample: terms.length,
    })
    expect(caseCount).toBeGreaterThan(200)
  })

  it('matches on a dense ternary tree (~3300 sweep queries)', () => {
    const dense = []
    function visit (prefix, depth) {
      if (depth === 4) return
      for (const c of ['a', 'b', 'c']) {
        const term = prefix + c
        dense.push(term)
        visit(term, depth + 1)
      }
    }
    visit('', 0)

    const { map, packed, terms } = buildIndexFromTerms(dense)
    const termSample = 100
    const { caseCount } = assertSweepParity({ map, packed, terms, termSample })
    expect(caseCount).toBeGreaterThan(3000)
  })

  it('matches on random ASCII terms (~3300 sweep queries)', () => {
    const randTerms = new Set()
    let s = 0xabcdef01
    while (randTerms.size < 120) {
      s = (s * 1664525 + 1013904223) >>> 0
      const len = 3 + (s % 10)
      let t = ''
      for (let i = 0; i < len; i++) {
        s = (s * 1664525 + 1013904223) >>> 0
        t += String.fromCharCode(97 + (s % 26))
      }
      randTerms.add(t)
    }

    const { map, packed, terms } = buildIndexFromTerms([...randTerms])
    const { caseCount } = assertSweepParity({
      map,
      packed,
      terms,
      termSample: 100,
    })
    expect(caseCount).toBeGreaterThan(3000)
  })
})
