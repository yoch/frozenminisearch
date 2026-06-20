import { invalidFrozenIndex } from './frozenErrors'
import type { FreqArray } from './compactPostings'
import { FLAG_FREQ_U16 } from './msv5/binaryMsv5Constants'

/** Global wire flags for {@link FreqArray} width. */
export function freqWireFlags(freqs: FreqArray): number {
  if (freqs instanceof Uint16Array) return FLAG_FREQ_U16
  return 0
}

export function readFreqsSection(
  buf: Buffer,
  globalFlags: number,
  postingCount: number,
): FreqArray {
  if ((globalFlags & FLAG_FREQ_U16) !== 0) {
    if (buf.length !== postingCount * 2) {
      throw invalidFrozenIndex('allFreqs u16 size mismatch')
    }
    return postingCount === 0
      ? new Uint16Array(0)
      : new Uint16Array(buf.buffer, buf.byteOffset, postingCount)
  }
  if (buf.length !== postingCount) {
    throw invalidFrozenIndex('allFreqs u8 size mismatch')
  }
  return postingCount === 0
    ? new Uint8Array(0)
    : new Uint8Array(buf.buffer, buf.byteOffset, postingCount)
}
