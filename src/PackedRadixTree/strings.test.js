import { labelSlice } from './strings'

describe('PackedRadixTree label helpers', () => {
  test('labelSlice reads a label by start and length', () => {
    expect(labelSlice('--alpha--', 2, 5)).toBe('alpha')
    expect(labelSlice('abc', 3, 0)).toBe('')
  })
})
