import { MAX_FREQ } from './compactPostings'
import { DISCARDED_DOC_ID, postingFreqValue } from './flatPostings'
import { materializeFrozenPostings } from './frozenPostings'
import { readDocId } from './compactPostings'

describe('flatPostings helpers', () => {
  test('postingFreqValue clamps only when requested', () => {
    const over = MAX_FREQ + 100
    expect(postingFreqValue(over, true)).toBe(MAX_FREQ)
    expect(postingFreqValue(over, false)).toBe(over)
    expect(postingFreqValue(3, undefined)).toBe(3)
  })

  test('materializeFrozenPostings skips DISCARDED_DOC_ID from remapDocId', () => {
    const layout = materializeFrozenPostings({
      fieldCount: 1,
      termCount: 1,
      nextId: 10,
      clampFrequencies: true,
      remapDocId: docId => (docId === 1 ? DISCARDED_DOC_ID : docId),
      forEachPosting(_ti, _fi, emit) {
        emit(1, 5)
        emit(2, 3)
      },
    })
    expect(layout.allDocIds.length).toBe(1)
    expect(readDocId(layout.allDocIds, 0)).toBe(2)
    expect(layout.allFreqs[0]).toBe(3)
  })

  test('materializeFrozenPostings applies frequency clamp on write', () => {
    const layout = materializeFrozenPostings({
      fieldCount: 1,
      termCount: 1,
      nextId: 5,
      clampFrequencies: true,
      forEachPosting(_ti, _fi, emit) {
        emit(0, MAX_FREQ + 50)
      },
    })
    expect(layout.allFreqs[0]).toBe(MAX_FREQ)
  })
})
