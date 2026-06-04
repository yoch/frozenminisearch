/* eslint-disable no-labels */
import { shouldPruneFuzzyEdge } from '../fuzzyLengthPrune'
import { LEAF } from './TreeIterator'
import type { RadixTree } from './types'

export type FuzzyResult<T> = [T, number]

export type FuzzyResults<T> = Map<string, FuzzyResult<T>>

/**
 * @ignore
 */
export const fuzzySearch = <T = any>(node: RadixTree<T>, query: string, maxDistance: number): FuzzyResults<T> => {
  const results: FuzzyResults<T> = new Map()
  if (query === undefined) return results

  // Number of columns in the Levenshtein matrix.
  const n = query.length + 1

  // Matching terms can never be longer than N + maxDistance.
  const m = n + maxDistance

  // Fill first matrix row and column with numbers: 0 1 2 3 ...
  const matrix = new Uint8Array(m * n).fill(maxDistance + 1)
  for (let j = 0; j < n; ++j) matrix[j] = j
  for (let i = 1; i < m; ++i) matrix[i * n] = i

  // ⚡ Bolt Optimization: Pre-compute query character codes
  // Comparing integer character codes is much faster in V8 than string character access and string comparison.
  const queryLen = query.length
  const queryCodes = new Uint16Array(queryLen)
  for (let j = 0; j < queryLen; j++) queryCodes[j] = query.charCodeAt(j)

  recurse(
    node,
    query,
    queryLen,
    queryCodes,
    maxDistance,
    results,
    matrix,
    1,
    n,
    '',
  )

  return results
}

// Modified version of http://stevehanov.ca/blog/?id=114

const recurse = <T = any>(
  node: RadixTree<T>,
  query: string,
  queryLen: number,
  queryCodes: Uint16Array,
  maxDistance: number,
  results: FuzzyResults<T>,
  matrix: Uint8Array,
  m: number,
  n: number,
  prefix: string,
): void => {
  const offset = m * n

  key: for (const key of node.keys()) {
    if (key === LEAF) {
      const distance = matrix[offset - 1]
      if (distance <= maxDistance) {
        results.set(prefix, [node.get(key)!, distance])
      }
    } else {
      // m = next matrix row index; dictionary prefix on path has length m - 1
      if (shouldPruneFuzzyEdge(m - 1, key.length, queryLen, maxDistance)) {
        continue key
      }

      let i = m
      for (let pos = 0; pos < key.length; ++pos, ++i) {
        const charCode = key.charCodeAt(pos)
        const thisRowOffset = n * i
        const prevRowOffset = thisRowOffset - n

        let minDistance = matrix[thisRowOffset]

        const jmin = Math.max(0, i - maxDistance - 1)
        const jmax = Math.min(queryLen, i + maxDistance)

        for (let j = jmin; j < jmax; ++j) {
          // ⚡ Bolt Optimization:
          // 1. Integer comparison (charCode === queryCodes[j]) is faster than string access and comparison.
          // 2. Returning 0 or 1 directly is faster than relying on coercion like `+different` or `+ +different`.
          const different = charCode === queryCodes[j] ? 0 : 1

          const rpl = matrix[prevRowOffset + j] + different
          const del = matrix[prevRowOffset + j + 1] + 1
          const ins = matrix[thisRowOffset + j] + 1

          // ⚡ Bolt Optimization:
          // Manual conditionals for minimum calculation avoids multi-argument Math.min overhead
          let dist = rpl
          if (del < dist) dist = del
          if (ins < dist) dist = ins
          matrix[thisRowOffset + j + 1] = dist

          if (dist < minDistance) minDistance = dist
        }

        if (minDistance > maxDistance) {
          continue key
        }
      }

      recurse(
        node.get(key)!,
        query,
        queryLen,
        queryCodes,
        maxDistance,
        results,
        matrix,
        i,
        n,
        prefix + key,
      )
    }
  }
}

export default fuzzySearch
