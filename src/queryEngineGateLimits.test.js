import {
  DEFAULT_AND_GATE_LIMITS,
  DEFAULT_POSTING_GATE_MIN_LENGTH,
  DEFAULT_POSTING_GATE_POLICY,
  gateFilterShrinksScan,
  gateIsSelectiveEnough,
  passGateByPostingRatio,
  resolveGateMaxSize,
  shouldPassGateAsAllowedDocs,
} from './queryEngineGateLimits'
import { shouldSeekAllowedDocs } from './compactPostings'

describe('queryEngineGateLimits', () => {
  test('resolveGateMaxSize uses absolute and fraction caps', () => {
    expect(resolveGateMaxSize(50_000, DEFAULT_AND_GATE_LIMITS)).toBe(5000)
    expect(resolveGateMaxSize(6000, DEFAULT_AND_GATE_LIMITS)).toBe(600)
    expect(resolveGateMaxSize(200, DEFAULT_AND_GATE_LIMITS)).toBe(100)
  })

  test('gateIsSelectiveEnough absolute path unchanged', () => {
    expect(gateIsSelectiveEnough(1, 50_000)).toBe(true)
    expect(gateIsSelectiveEnough(5000, 50_000)).toBe(true)
    expect(gateIsSelectiveEnough(5001, 50_000)).toBe(false)
    expect(gateIsSelectiveEnough(0, 50_000)).toBe(true)
  })

  test('passGateByPostingRatio default policy', () => {
    expect(passGateByPostingRatio(11_111, 50_000)).toBe(true)
    expect(passGateByPostingRatio(11_111, 10_000)).toBe(false)
    expect(passGateByPostingRatio(10_000, 10_000)).toBe(false)
    expect(passGateByPostingRatio(1, 1024)).toBe(false)
    expect(passGateByPostingRatio(1, 2048)).toBe(true)
  })

  test('gateIsSelectiveEnough posting ratio path for giant-like gate', () => {
    expect(gateIsSelectiveEnough(11_111, 50_000, DEFAULT_AND_GATE_LIMITS, 50_000)).toBe(true)
    expect(gateIsSelectiveEnough(11_111, 50_000, DEFAULT_AND_GATE_LIMITS, 10_000)).toBe(false)
  })

  test('gateIsSelectiveEnough posting ratio rejects full-list gate', () => {
    expect(gateIsSelectiveEnough(10_000, 10_000, DEFAULT_AND_GATE_LIMITS, 10_000)).toBe(false)
  })

  test('DEFAULT_POSTING_GATE_POLICY matches compactPostings seek threshold', () => {
    expect(DEFAULT_POSTING_GATE_POLICY.minLength).toBe(2048)
    expect(DEFAULT_POSTING_GATE_POLICY.ratioShift).toBe(2)
    expect(DEFAULT_POSTING_GATE_MIN_LENGTH).toBe(2048)
  })

  test('gateFilterShrinksScan and shouldPassGateAsAllowedDocs', () => {
    expect(gateFilterShrinksScan(16, 12)).toBe(false)
    expect(gateFilterShrinksScan(16, 16)).toBe(false)
    expect(gateFilterShrinksScan(16, 17)).toBe(true)
    expect(gateFilterShrinksScan(11_111, 50_000)).toBe(true)

    expect(shouldPassGateAsAllowedDocs(true, 16, 12)).toBe(false)
    expect(shouldPassGateAsAllowedDocs(true, 16, 17)).toBe(true)
    expect(shouldPassGateAsAllowedDocs(true, 11_111, 50_000)).toBe(true)
    expect(shouldPassGateAsAllowedDocs(false, 16, 12)).toBe(false)
    expect(shouldPassGateAsAllowedDocs(true, 0, 100)).toBe(false)
    expect(shouldPassGateAsAllowedDocs(true, 16, undefined)).toBe(false)
  })

  test('shouldSeekAllowedDocs delegates to passGateByPostingRatio (distinct decision, same numbers)', () => {
    const cases = [
      [11_111, 50_000],
      [10_000, 10_000],
      [100, 10_000],
      [1, 100],
      [1, 2048],
      [1, 1024],
    ]
    for (const [gateSize, listLength] of cases) {
      expect(shouldSeekAllowedDocs(gateSize, listLength)).toBe(
        passGateByPostingRatio(gateSize, listLength),
      )
    }
  })
})
