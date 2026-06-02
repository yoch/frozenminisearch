import {
  buildFuzzySweepQueries,
  planSweepSize,
  SINGLE_EDIT_MUTATIONS,
} from './fuzzyQueryMutations.js'

describe('buildFuzzySweepQueries', () => {
  it('builds term × mutation × k cases', () => {
    const terms = ['paracetamol', 'doliprane', 'ibuprofene', 'amoxicilline', 'metformine']
    const plan = planSweepSize({ termCount: 5, includeDoubleEdits: true })
    expect(plan.mutationsPerTerm).toBe(SINGLE_EDIT_MUTATIONS.length * 3 + 3 * 2)

    const cases = buildFuzzySweepQueries({
      terms,
      termSample: 5,
      seed: 1,
      includeDoubleEdits: true,
    })
    expect(cases.length).toBe(5 * plan.mutationsPerTerm)
    expect(cases.every((c) => c.query && c.maxDistance >= c.edits)).toBe(true)
    expect(cases.some((c) => c.mutation === 'subMid' && c.maxDistance === 1)).toBe(true)
    expect(cases.some((c) => c.mutation === 'subStart+delEnd' && c.maxDistance === 2)).toBe(true)
  })
})
