import { madOf, madRound, madMbRound, median, DEFAULT_HEAP_GC_PASSES, DEFAULT_HEAP_WARMUP, HEAP_BENCH_PROTOCOL_VERSION } from './benchStats.js'
import { defaultHeapWarmup } from './benchmarkUtils.js'

describe('heap benchStats', () => {
  test('madOf measures spread around median', () => {
    const samples = [10, 12, 11, 50, 11]
    expect(madOf(samples)).toBe(1)
    expect(madRound(samples)).toBe(1)
  })

  test('madMbRound converts byte MAD to megabytes', () => {
    const oneMb = 1024 * 1024
    expect(madMbRound([0, oneMb, 2 * oneMb])).toBe(1)
  })

  test('median handles even-length arrays', () => {
    expect(median([3, 1, 2, 4])).toBe(2.5)
    expect(median([10, 12, 11])).toBe(11)
  })

  test('heap protocol version is 4', () => {
    expect(HEAP_BENCH_PROTOCOL_VERSION).toBe(4)
    expect(DEFAULT_HEAP_GC_PASSES).toBe(3)
    expect(DEFAULT_HEAP_WARMUP).toBe(2)
    expect(defaultHeapWarmup(5000)).toBe(2)
    expect(defaultHeapWarmup(100_000)).toBe(2)
  })
})
