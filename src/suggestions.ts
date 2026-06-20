import { byScore, type RawResult } from './scoring'
import type { SearchResult, Suggestion } from './searchTypes'

type SuggestionHit = Pick<SearchResult, 'score' | 'terms'>

function buildSuggestions(
  hits: Iterable<SuggestionHit>,
): Suggestion[] {
  const suggestions = new Map<string, { score: number, terms: string[], count: number }>()

  for (const { score, terms } of hits) {
    addSuggestion(suggestions, score, terms)
  }

  return finalizeSuggestions(suggestions)
}

function addSuggestion(
  suggestions: Map<string, { score: number, terms: string[], count: number }>,
  score: number,
  terms: string[],
): void {
  const phrase = terms.join(' ')
  const suggestion = suggestions.get(phrase)
  if (suggestion != null) {
    suggestion.score += score
    suggestion.count += 1
  } else {
    suggestions.set(phrase, { score, terms, count: 1 })
  }
}

function finalizeSuggestions(
  suggestions: Map<string, { score: number, terms: string[], count: number }>,
): Suggestion[] {
  const results: Suggestion[] = []
  for (const [suggestion, { score, terms, count }] of suggestions) {
    results.push({ suggestion, terms, score: score / count })
  }

  results.sort(byScore)
  return results
}

function finalRawScore(score: number, terms: readonly string[]): number {
  return score * (terms.length || 1)
}

/** Aggregate search hits into ranked phrase suggestions. */
export function suggestFromSearchResults(
  hits: Iterable<SuggestionHit>,
): Suggestion[] {
  return buildSuggestions(hits)
}

/** Build suggestions from raw search hits without materializing full public results. */
export function suggestFromRawResults(
  rawResults: RawResult,
): Suggestion[] {
  let allScoresEqual = true
  let firstScore: number | undefined

  for (const { score, terms } of rawResults.values()) {
    const finalScore = finalRawScore(score, terms)
    if (firstScore == null) {
      firstScore = finalScore
    } else if (finalScore !== firstScore) {
      allScoresEqual = false
      break
    }
  }

  if (allScoresEqual) {
    const suggestions = new Map<string, { score: number, terms: string[], count: number }>()
    for (const { score, terms, match } of rawResults.values()) {
      addSuggestion(suggestions, finalRawScore(score, terms), Object.keys(match))
    }
    return finalizeSuggestions(suggestions)
  }

  const hits = new Array<SuggestionHit>(rawResults.size)
  let write = 0

  for (const { score, terms, match } of rawResults.values()) {
    hits[write++] = {
      score: finalRawScore(score, terms),
      terms: Object.keys(match),
    }
  }

  if (hits.length > 1) {
    hits.sort(byScore)
  }

  return buildSuggestions(hits)
}
