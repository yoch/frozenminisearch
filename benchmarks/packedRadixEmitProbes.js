/**
 * Discover prefix probes with realistic fan-out for emitSubtree CPU benches.
 * One linear scan of terms (setup only, not timed).
 */

const DEFAULT_SAMPLE_MAX = 80_000
const DEFAULT_SHORT_LEN = 2
const DEFAULT_WIDE_TARGET = 1000

/** @param {import('../src/PackedRadixTree/PackedRadixTree.ts').default} tree */
export function countPrefixEntries (tree, prefix) {
  let n = 0
  // eslint-disable-next-line no-unused-vars -- count-only; no materialized match array
  for (const _ of tree.prefixRefs(prefix)) n++
  return n
}

/**
 * @param {import('../src/PackedRadixTree/PackedRadixTree.ts').default} tree
 * @param {{
 *   sampleMax?: number
 *   shortLen?: number
 *   wideTarget?: number
 *   minWideLen?: number
 *   maxWideLen?: number
 *   minWideMatches?: number
 * }} [options]
 */
export function discoverPrefixProbes (tree, options = {}) {
  const {
    sampleMax = DEFAULT_SAMPLE_MAX,
    shortLen = DEFAULT_SHORT_LEN,
    wideTarget = DEFAULT_WIDE_TARGET,
    minWideLen = 2,
    maxWideLen = 10,
    minWideMatches = 50,
  } = options

  /** @type {Map<string, number>} */
  const hist = new Map()
  let sampled = 0
  let fullScan = true

  for (const [term] of tree.entries()) {
    if (sampled >= sampleMax) {
      fullScan = false
      break
    }
    sampled++
    const maxLen = Math.min(maxWideLen, term.length)
    for (let len = shortLen; len <= maxLen; len++) {
      const p = term.slice(0, len)
      hist.set(p, (hist.get(p) ?? 0) + 1)
    }
  }

  let prefixShort = ''
  let shortHistCount = 0
  for (const [p, c] of hist) {
    if (p.length === shortLen && c > shortHistCount) {
      shortHistCount = c
      prefixShort = p
    }
  }
  if (!prefixShort && hist.size > 0) {
    const [p, c] = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]
    prefixShort = p
    shortHistCount = c
  }

  let prefixWide = prefixShort
  let wideHistCount = shortHistCount
  let bestDiff = Infinity
  for (const [p, c] of hist) {
    if (p.length < minWideLen || p.length > maxWideLen) continue
    if (c < minWideMatches) continue
    const diff = Math.abs(c - wideTarget)
    if (diff < bestDiff) {
      bestDiff = diff
      prefixWide = p
      wideHistCount = c
    }
  }

  const prefixCount = (prefix) => (
    fullScan ? (hist.get(prefix) ?? 0) : countPrefixEntries(tree, prefix)
  )
  const shortTerms = prefixCount(prefixShort)
  const wideTerms = prefixCount(prefixWide)

  return {
    sampled,
    fullScan,
    prefixShort,
    shortTerms,
    shortHistCount,
    prefixWide,
    wideTerms,
    wideHistCount,
    wideTarget,
  }
}
