import MiniSearch from 'minisearch'
import FrozenMiniSearch from '../../src/FrozenMiniSearch'

export function expectSameSuggestions (a, b) {
  expect(a.length).toBe(b.length)
  const norm = list => list.map(s => ({
    score: s.score,
    terms: [...s.terms].sort(),
  })).sort((x, y) => y.score - x.score)
  expect(norm(b)).toEqual(norm(a))
}

export function expectSameWildcardResults (mutable, frozen, searchOptions = {}) {
  const a = mutable.search(MiniSearch.wildcard, searchOptions)
  const b = frozen.search(FrozenMiniSearch.wildcard, searchOptions)
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) {
    expect(b[i].id).toBe(a[i].id)
    expect(b[i].score).toBeCloseTo(a[i].score, 6)
    expect([...b[i].terms].sort()).toEqual([...a[i].terms].sort())
    expect(b[i].match).toEqual(a[i].match)
    const { score, terms, match, id, queryTerms, ...storedA } = a[i]
    const { score: _s, terms: _t, match: _m, id: _i, queryTerms: _q, ...storedB } = b[i]
    expect(storedB).toEqual(storedA)
  }
}

export function expectSameResults (mutable, frozen, query, searchOptions = {}, { scorePrecision = 6 } = {}) {
  const a = mutable.search(query, searchOptions)
  const b = frozen.search(query, searchOptions)
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) {
    expect(b[i].id).toBe(a[i].id)
    // toBeCloseTo rather than toBe because FrozenMiniSearch stores avgFieldLength as
    // Float32Array while MiniSearch uses Float64.  For most corpus values the
    // representations are identical, but after discard() (without vacuum) the
    // updated average can be an irrational fraction (e.g. 13/3) that has a tiny
    // Float32 vs Float64 rounding gap.  Precision 6 (|Δ| < 5e-7) is tight enough
    // to catch any real scoring regression.
    expect(b[i].score).toBeCloseTo(a[i].score, scorePrecision)
    expect([...b[i].terms].sort()).toEqual([...a[i].terms].sort())
    expect(b[i].match).toEqual(a[i].match)
    const { score, terms, match, id, queryTerms, ...storedA } = a[i]
    const { score: _s, terms: _t, match: _m, id: _i, queryTerms: _q, ...storedB } = b[i]
    expect(storedB).toEqual(storedA)
  }
}
