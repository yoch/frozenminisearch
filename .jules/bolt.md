## 2024-06-04 - Levenshtein Distance Calculation Optimizations
**Learning:** V8 optimizes `Math.min`/`Math.max` surprisingly well compared to manual ternaries/ifs, but string character comparisons can be faster if we cache `charCodeAt()` arrays for the query string when doing many fuzzy matching operations against a static query.
**Action:** Let's see if we can use the `charCodeAt()` optimization from `PackedRadixTree/fuzzy.ts` inside `SearchableMap/fuzzySearch.ts` which is still using string comparisons and `+ +different`.
