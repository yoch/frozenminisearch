import { byScore } from './scoring'
import type { SearchOptions, SearchResult, Suggestion } from './searchTypes'

/** Aggregate search hits into ranked phrase suggestions. */
export function suggestFromSearchResults(
  hits: Iterable<Pick<SearchResult, 'score' | 'terms'>>,
): Suggestion[] {
  const suggestions = new Map<string, { score: number, terms: string[], count: number }>()

  for (const { score, terms } of hits) {
    const phrase = terms.join(' ')
    const suggestion = suggestions.get(phrase)
    if (suggestion != null) {
      suggestion.score += score
      suggestion.count += 1
    } else {
      suggestions.set(phrase, { score, terms, count: 1 })
    }
  }

  const results: Suggestion[] = []
  for (const [suggestion, { score, terms, count }] of suggestions) {
    results.push({ suggestion, terms, score: score / count })
  }

  results.sort(byScore)
  return results
}

export type SearchFn = (query: string, options?: SearchOptions) => SearchResult[]

/** Run a search and turn hits into suggestions (shared by mutable and frozen indexes). */
export function autoSuggestFromSearch(
  search: SearchFn,
  queryString: string,
  options: SearchOptions = {},
): Suggestion[] {
  return suggestFromSearchResults(search(queryString, options))
}
