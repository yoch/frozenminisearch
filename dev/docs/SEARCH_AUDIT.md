# Search and retention audit — 2026-10-12

Baseline: published 1.12.0, commit `85e05e6ca1b1892cdf939d01942435d6f33c739b`.
Tests use Node.js 24.19.0. This is a follow-up to [the memory audit](MEMORY_AUDIT.md),
covering the new `matchIds()` and `matchInfo: false` paths as well as search correctness.

## Confirmed defect and fix

With a whitespace tokenizer and the document `alpha __proto__`, combining matches
for `alpha __proto__` lost the second term from `terms` and changed the prototype
of the result's `match` object. Prefix accumulation, stored fields and indexed
fields with this literal name had related failures. These are per-object prototype
assignment defects, not evidence that `Object.prototype` itself was modified.

Arbitrary keys are now written as own data properties. Six public-API regression
cases cover AND/OR, suggestions, prefix expansion, indexed fields, single/multiple
stored fields and binary/JSON round trips. Ordinary result object prototypes and
the MSv5 format are preserved.

## Correctness checks

- `pnpm test`, with `CORPUS_EXPORT_DIR` pointing to exported medical documents:
  **842 passed**, including the eight optional corpus cases.
- `pnpm coverage`: **844 passed**, eight optional corpus cases skipped in this run;
  96.64% line coverage. Includes browser tests.
- `pnpm test:runtime`: **39 passed** against the built bundles.
- Build, lint/typecheck, internal boundary check, Knip and npm package-content
  verification passed. Lint reports one pre-existing stylistic warning in
  `src/docIdBitSet.test.js`.
- `node dev/scripts/audit-search-correctness.cjs`: **20,250 assertions passed**.
  Seed 127391, nine corpus sizes around bitset word boundaries, three construction
  paths, AND/OR/AND_NOT, nested queries, field selection, document boosts, prefix,
  fuzzy, filtered limits and page totals. Matched ids agree with MiniSearch 7.2;
  `matchIds` agrees with full search; omitting match information preserves scores,
  stored fields and ordering.
- Targeted `extreme-giantVocabulary` search benchmark completed, exercising exact,
  prefix, AND+prefix and AND_NOT. This single run is a workload check, not a claim
  of a statistically significant performance improvement.
- The medical API's **306 tests** also passed using this built bundle.

## Retention checks

Run `node --expose-gc dev/scripts/audit-memory-retention.cjs [entry] [output]`
separately for the published 1.12.0 bundle and the patched bundle. The harness now
also exercises `matchIds()` and `matchInfo: false`.

Both runs covered seven medical indexes (94,666 documents), 1,800 searches,
85 successful loads and 36 deliberately corrupted snapshots. The ordinary-query
result digest was identical:
`f87523059cacc1ef6b8b8dab171a38019a0b1d93467d1519d6fbcb7f2c3d5dd2`.

All 85 retired indexes, 72 sampled result arrays and tracked source buffers were
collected. The ingestion-only closure payload was collected while its finished
builder and index remained alive; the idle cursor prefix was empty.

On the patched bundle, post-GC heap went from 10.00 MiB after the first search
batch to 10.07 MiB after the sixth, then 6.41 MiB after dropping the fixture indexes.
External memory fell from 8.96 to 2.04 MiB. RSS remained around 268 MiB after the
indexes were dropped: this did not correspond to retained index objects.

No additional accumulating retention was detected in these workloads. The earlier
audit's transient allocation findings still apply: very long fuzzy tokens allocate
a quadratic matrix, eager `addAllAsync` scheduling can have a large temporary
cost, and browser decompression has a different peak profile from Node. The medical
API follow-up bounds HTTP search queries to 512 characters. These local tests do
not replace observation of the production process over time.
