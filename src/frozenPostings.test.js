import { choosePostingsLayout } from './frozenPostings'

describe('choosePostingsLayout', () => {
  test('single field prefers dense when slots have postings', () => {
    expect(choosePostingsLayout(1, 100, 50)).toBe('dense')
  })

  test('zero non-empty slots prefers sparse metadata', () => {
    // denseBytes = 100 * 1 * 8 = 800; sparseBytes = 101 * 4 = 404
    expect(choosePostingsLayout(1, 100, 0)).toBe('sparse')
  })

  test('tie on metadata bytes prefers dense', () => {
    // denseBytes = 2 * 3 * 8 = 48
    // sparseBytes = 3 * 4 + 4 * (1 + 8) = 12 + 36 = 48
    expect(choosePostingsLayout(3, 2, 4)).toBe('dense')
  })

  test('multi-field dense when most slots are non-empty', () => {
    // 3 terms × 4 fields, all 12 slots filled
    // denseBytes = 3 * 4 * 8 = 96
    // sparseBytes = 4 * 4 + 12 * (1 + 8) = 16 + 108 = 124
    expect(choosePostingsLayout(4, 3, 12)).toBe('dense')
  })

  test('multi-field sparse when few slots are non-empty', () => {
    // 10 terms × 4 fields, 3 non-empty slots
    // denseBytes = 10 * 4 * 8 = 320
    // sparseBytes = 11 * 4 + 3 * (1 + 8) = 44 + 27 = 71
    expect(choosePostingsLayout(4, 10, 3)).toBe('sparse')
  })

  test('uses 16-bit sparse field ids when fieldCount exceeds 255', () => {
    // denseBytes = 1 * 256 * 8 = 2048
    // sparseBytes = 2 * 4 + 1 * (2 + 8) = 8 + 10 = 18
    expect(choosePostingsLayout(256, 1, 1)).toBe('sparse')
  })

  test('empty term count prefers dense', () => {
    expect(choosePostingsLayout(4, 0, 0)).toBe('dense')
  })
})
