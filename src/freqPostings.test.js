import { FLAG_FREQ_U16 } from './msv5/binaryMsv5Constants'
import { freqWireFlags, readFreqsSection } from './freqPostings'

describe('freqPostings wire helpers', () => {
  test('freqWireFlags reflects Uint16Array storage', () => {
    expect(freqWireFlags(new Uint8Array([1, 2, 3]))).toBe(0)
    expect(freqWireFlags(new Uint16Array([1, 2, 3]))).toBe(FLAG_FREQ_U16)
  })

  test('readFreqsSection returns u8 view when FLAG_FREQ_U16 is clear', () => {
    const bytes = new Uint8Array([4, 5, 6])
    const freqs = readFreqsSection(bytes, 0, 3)
    expect(freqs).toBeInstanceOf(Uint8Array)
    expect(Array.from(freqs)).toEqual([4, 5, 6])
  })

  test('readFreqsSection returns u16 view when FLAG_FREQ_U16 is set', () => {
    const backing = new Uint8Array([0x2a, 0x01, 0x10, 0x00])
    const freqs = readFreqsSection(backing, FLAG_FREQ_U16, 2)
    expect(freqs).toBeInstanceOf(Uint16Array)
    expect(Array.from(freqs)).toEqual([0x012a, 0x0010])
  })

  test('readFreqsSection rejects u8 size mismatch', () => {
    expect(() => readFreqsSection(new Uint8Array([1, 2]), 0, 3))
      .toThrow(/allFreqs u8 size mismatch/)
  })

  test('readFreqsSection rejects u16 size mismatch', () => {
    expect(() => readFreqsSection(new Uint8Array([1, 2, 3]), FLAG_FREQ_U16, 2))
      .toThrow(/allFreqs u16 size mismatch/)
  })

  test('readFreqsSection returns empty typed arrays for zero postings', () => {
    expect(readFreqsSection(new Uint8Array(0), 0, 0)).toEqual(new Uint8Array(0))
    expect(readFreqsSection(new Uint8Array(0), FLAG_FREQ_U16, 0)).toEqual(new Uint16Array(0))
  })
})
