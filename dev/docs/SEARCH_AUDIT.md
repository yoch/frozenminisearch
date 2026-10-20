# Search and retention audit — 2026-10-12

Baseline: published 1.12.0, commit `85e05e6ca1b1892cdf939d01942435d6f33c739b`.
Tests use Node.js 24.19.0. This is a follow-up to [the memory audit](MEMORY_AUDIT.md),
covering the new `matchIds()` and `matchInfo: false` paths as well as search correctness.

## Prototype-named keys

**Indexed field named `__proto__` (fixed).** With `fields: ['title', '__proto__']`,
`fieldIds.__proto__ = 1` was ignored: terms of the `__proto__` field were attributed
to `title` (wrong ids and `match`), searching `fields: ['__proto__']` found nothing,
and `saveBinarySync()` threw `fieldIds count mismatch`. MiniSearch returns correct
results for this case. Field ids (build and binary decode) and per-query field
boosts are now created with `Object.create(null)`, three one-line changes; results
now match MiniSearch exactly.

V8 keeps such objects in dictionary mode, and they are read once per derived term
and field. An interleaved run on a 40,000-document, four-field index (one process
per measurement, ten rounds, pinned core, master duplicated as an A/A control)
showed no measurable difference on Node 24.18 or Bun 1.4.4, for mixed queries and
for short-prefix queries: every median was within the A/A spread (up to 4.6%).

**Literal `__proto__` terms and stored-field keys (unchanged, same as MiniSearch).**
With a custom tokenizer that keeps `_`, combining matches for `alpha __proto__`
drops the second term from `terms` and `match` and changes the prototype of
`match`; `__proto__ alpha` keeps it. A stored field with that name changes the
result's prototype instead of becoming an own key. Ids and scores are unaffected.
Fixing this needs a special case at every place that writes a user key into a
public object; it was prototyped (first version of #28) and dropped as not worth
the convention. The parity contract records the behaviour.

**`Object.prototype`** is never modified, on any path: build, search, suggestions,
stored fields, binary/JSON round trips and untrusted snapshot rows.
`src/prototypeKeys.test.js` checks this after every case. An untrusted JSON snapshot
can make results inherit values through a `__proto__` key in a stored-field row,
but the same snapshot can already add arbitrary own keys to those rows, including
`id` and `score`, so this gives no additional capability.

## Correctness checks

The figures below were measured on the first version of #28 (own-property writes);
the final three-line fix was rechecked with `pnpm test`, `pnpm test:runtime` and the
audit script.

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
