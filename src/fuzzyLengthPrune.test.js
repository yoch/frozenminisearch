import { shouldPruneFuzzyEdge } from './fuzzyLengthPrune'

describe('shouldPruneFuzzyEdge', () => {
  it('prunes when prefix plus edge exceeds query length plus k', () => {
    expect(shouldPruneFuzzyEdge(0, 10, 3, 1)).toBe(true)
    expect(shouldPruneFuzzyEdge(2, 3, 3, 1)).toBe(true)
    expect(shouldPruneFuzzyEdge(0, 4, 3, 1)).toBe(false)
    expect(shouldPruneFuzzyEdge(0, 4, 3, 2)).toBe(false)
  })

  it('does not prune short prefixes that can still grow', () => {
    expect(shouldPruneFuzzyEdge(0, 1, 5, 2)).toBe(false)
    expect(shouldPruneFuzzyEdge(1, 1, 5, 1)).toBe(false)
  })
})
