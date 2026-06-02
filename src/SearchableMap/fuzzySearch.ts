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

  recurse(
    node,
    query,
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
      if (shouldPruneFuzzyEdge(m - 1, key.length, query.length, maxDistance)) {
        continue key
      }

      let i = m
      for (let pos = 0; pos < key.length; ++pos, ++i) {
        const char = key[pos]
        const thisRowOffset = n * i
        const prevRowOffset = thisRowOffset - n

        let minDistance = matrix[thisRowOffset]

        const jmin = Math.max(0, i - maxDistance - 1)
        const jmax = Math.min(n - 1, i + maxDistance)

        for (let j = jmin; j < jmax; ++j) {
          const different = char !== query[j]

          const rpl = matrix[prevRowOffset + j] + +different
          const del = matrix[prevRowOffset + j + 1] + 1
          const ins = matrix[thisRowOffset + j] + 1

          const dist = matrix[thisRowOffset + j + 1] = Math.min(rpl, del, ins)

          if (dist < minDistance) minDistance = dist
        }

        if (minDistance > maxDistance) {
          continue key
        }
      }

      recurse(
        node.get(key)!,
        query,
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
