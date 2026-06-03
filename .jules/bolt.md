## 2024-06-03 - Math.min Overhead in Hot Loops
**Learning:** In V8, `Math.min(a, b, c)` inside extremely hot dynamic programming loops (like the inner loop of a fuzzy string matcher computing Levenshtein distance) introduces significant overhead compared to manual `if` conditional checks. Replacing it improved benchmark execution time by ~10% without loss of readability.
**Action:** When optimizing tight algorithm loops, prefer manual inline checks for `Math.min`/`Math.max` and avoid type coercion like `+ +boolean` in favor of simple conditionally incrementing variables.
