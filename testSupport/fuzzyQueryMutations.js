/** Generate typo queries from existing index terms (deterministic). */
import { mulberry32 } from './mulberry32.js'

function replaceCodeUnit (s, index) {
  const c = s.charCodeAt(index)
  const next = (c === 122 || c === 90 || c === 57) ? (c <= 90 ? 65 : 97) : c + 1
  return s.slice(0, index) + String.fromCharCode(next) + s.slice(index + 1)
}

function midIndex (s) {
  return Math.floor(s.length / 2)
}

/**
 * Single-edit mutations (position: start / middle / end).
 * @type {Array<{ id: string, edits: number, apply: (term: string) => string | null }>}
 */
export const SINGLE_EDIT_MUTATIONS = [
  { id: 'subStart', edits: 1, apply: (t) => (t.length >= 1 ? replaceCodeUnit(t, 0) : null) },
  { id: 'subMid', edits: 1, apply: (t) => (t.length >= 3 ? replaceCodeUnit(t, midIndex(t)) : null) },
  { id: 'subEnd', edits: 1, apply: (t) => (t.length >= 1 ? replaceCodeUnit(t, t.length - 1) : null) },
  { id: 'delStart', edits: 1, apply: (t) => (t.length >= 2 ? t.slice(1) : null) },
  { id: 'delMid', edits: 1, apply: (t) => (t.length >= 3 ? t.slice(0, midIndex(t)) + t.slice(midIndex(t) + 1) : null) },
  { id: 'delEnd', edits: 1, apply: (t) => (t.length >= 2 ? t.slice(0, -1) : null) },
  { id: 'insStart', edits: 1, apply: (t) => `x${t}` },
  { id: 'insMid', edits: 1, apply: (t) => (t.length >= 1 ? t.slice(0, midIndex(t)) + `x${t.slice(midIndex(t))}` : null) },
  { id: 'insEnd', edits: 1, apply: (t) => `${t}x` },
]

/** Two-edit mutations for k>=2 sweeps. */
export const DOUBLE_EDIT_MUTATIONS = [
  {
    id: 'subStart+delEnd',
    edits: 2,
    apply: (t) => {
      if (t.length < 3) return null
      return replaceCodeUnit(t, 0).slice(0, -1)
    },
  },
  {
    id: 'delStart+subEnd',
    edits: 2,
    apply: (t) => {
      if (t.length < 3) return null
      const u = t.slice(1)
      return replaceCodeUnit(u, u.length - 1)
    },
  },
  {
    id: 'subMid+insMid',
    edits: 2,
    apply: (t) => {
      if (t.length < 3) return null
      const m = midIndex(t)
      const sub = replaceCodeUnit(t, m)
      return sub.slice(0, m) + `x${sub.slice(m)}`
    },
  },
]

export const K_VALUES = [1, 2, 3]

export function collectTerms (tree) {
  const terms = []
  for (const [term] of tree.entries()) {
    if (term.length >= 2) terms.push(term)
  }
  return terms
}

export function sampleTerms (terms, count, seed) {
  if (terms.length <= count) return [...terms]
  const rand = mulberry32(seed)
  const indices = terms.map((_, i) => i)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = indices[i]
    indices[i] = indices[j]
    indices[j] = tmp
  }
  return indices.slice(0, count).map((i) => terms[i])
}

/**
 * Build (query, maxDistance, meta) cases: sampleTerms × mutations × k.
 * Skips when maxDistance < mutation edit count.
 */
export function buildFuzzySweepQueries ({
  terms,
  termSample,
  seed = 0xfeedf00d,
  includeDoubleEdits = true,
  kValues = K_VALUES,
  singleMutations = SINGLE_EDIT_MUTATIONS,
  doubleMutations = DOUBLE_EDIT_MUTATIONS,
}) {
  const picked = sampleTerms(terms, termSample, seed)
  const mutations = includeDoubleEdits
    ? [...singleMutations, ...doubleMutations]
    : singleMutations

  const cases = []
  for (const baseTerm of picked) {
    for (const mut of mutations) {
      const query = mut.apply(baseTerm)
      if (query == null || query === baseTerm) continue
      for (const maxDistance of kValues) {
        if (maxDistance < mut.edits) continue
        cases.push({
          query,
          maxDistance,
          baseTerm,
          mutation: mut.id,
          edits: mut.edits,
        })
      }
    }
  }
  return cases
}

export function planSweepSize ({
  termCount,
  includeDoubleEdits = true,
  kValues = K_VALUES,
}) {
  const single = SINGLE_EDIT_MUTATIONS.length
  const double = includeDoubleEdits ? DOUBLE_EDIT_MUTATIONS.length : 0
  let combos = 0
  for (const mut of [...SINGLE_EDIT_MUTATIONS, ...(includeDoubleEdits ? DOUBLE_EDIT_MUTATIONS : [])]) {
    combos += kValues.filter((k) => k >= mut.edits).length
  }
  return {
    mutationsPerTerm: combos,
    estimatedQueries: termCount * combos,
    singleMutations: single,
    doubleMutations: double,
  }
}
