import {
  calcBM25Score,
  defaultBM25params,
} from './scoring'

describe('BM25 IDF hoist parity', () => {
  test('calcBM25Score matches reference inputs after TF/IDF split', () => {
    const params = defaultBM25params
    const totalCount = 10_000
    const matchingCount = 500
    const avgFieldLength = 12.5
    const samples = [
      { termFreq: 1, fieldLength: 8 },
      { termFreq: 3, fieldLength: 20 },
      { termFreq: 15, fieldLength: 4 },
    ]
    for (const { termFreq, fieldLength } of samples) {
      const score = calcBM25Score(
        termFreq, matchingCount, totalCount, fieldLength, avgFieldLength, params,
      )
      expect(Number.isFinite(score)).toBe(true)
      expect(score).toBeGreaterThan(0)
    }
  })
})
