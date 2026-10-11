# Memory lifetime audit — 2026-10-11

Audited `@yoch/frozenminisearch` 1.11.0 and the fixes based on
`0ed1091a29f42bd7b8fc40828efecca53fd4881c`. The investigation includes both
accumulating leaks and reachable data that has outlived its purpose. The trigger
was a Node.js REST service whose RSS rose from 149 to 154 MB after restart.
That observation alone does not establish a leak or identify its source.

## Confirmed retention, now fixed

| Owner and retaining path | Reproduction on 1.11.0 | Change |
| --- | --- | --- |
| A terminal builder → document IDs, stored fields, terms and posting scratch | A token longer than 65,535 characters causes radix packing to fail after the builder becomes frozen. Retaining three failed builders retains three 8 MiB payloads (24 MiB total). | `freezeParams()` releases transient state in `finally`, including failures in posting finalization. |
| Frozen index → resolved options → ingestion callbacks → captured objects | An `extractField` closure capturing a 16 MiB buffer keeps that buffer alive after successful construction, with no stored fields. The finished builder also retains the callbacks. | Assembly and the core constructor discard `extractField` / `stringifyField` callbacks. A finished builder replaces its options, releasing all custom callbacks. |
| Radix tree → shared traversal cursor → last prefix string | A prefix search leaves `paracetamol` in the idle cursor's `base`. This is one retained string per tree, not an accumulating query cache. | Clear `base` and `depth` when releasing the cursor, also on callback errors and reentrant searches. |

The ingestion-closure reproduction now collects the buffer **while the index and
finished builder remain alive**. The three failed builders also remain alive in
the measurement, but their discarded buffers are collected. Both results were
checked against the installed, unchanged 1.11.0 package in separate Node processes.

Query tokenizers, term processors, filters and scoring callbacks remain available
to the index because searches still need them. Caller-owned options are not
mutated. If a required query callback itself captures a corpus, or shares a V8
closure context with a callback that captures it, that corpus can still be retained;
the library cannot discard a callback it must execute. No search ranking, public
method signature or MSv5 binary format change is intended.

## Other memory pressure found

These paths are not cumulative leaks in the measurements and are not changed by
this patch:

- `FrozenIndexBuilder.addAllAsync` eagerly constructs its entire promise/chunk
  chain. With 50,000 documents, `chunkSize: 1`, and an extractor failing on the first
  document, scheduling alone added **26.20 MiB of heap**. The allocation disappeared
  after rejection and GC. A bounded scheduling loop is a separate optimization;
  it must consider the current eager snapshot of document references and error/
  yield semantics. The REST service uses `fromAsyncIterable` or synchronous `add`,
  not this method.
- `PackedRadixTree/fuzzy.ts` allocates a matrix proportional to
  `(query.length + 1) * (query.length + 1 + maxDistance)`. A 4,096-character token
  added **16.04 MiB of ArrayBuffers**, even with no matches. GC released it.
  Limiting edit distance alone does not bound this quadratic allocation. Bounding
  token length at the service boundary or redesigning the matrix requires separate
  search-behavior/performance validation. The REST service does use fuzzy searches.
- The browser zlib loader materializes the decompressed body before checking its
  declared decoded length (`msv5/compressionBrowser.ts` and
  `msv5/binaryMsv5CompressionBrowser.ts`). An oversized decoded body can cause a
  transient peak. This was identified by source inspection, not by a browser
  memory experiment; the Node service does not use this implementation.

## Ownership and lifetime review

| Area | Finding |
| --- | --- |
| Query engine, scoring, suggestions | Result maps, candidate sets and scoring arrays are local to the query. No unbounded global query/result cache found. Retired sampled result arrays were collected. |
| Nested queries and exceptions | `_activeQueries` and cursor ownership unwind in `finally`; regression tests exercise a nested search from a throwing scoring callback. |
| Tree cursor pool | One shared cursor per tree; nested traversals get a temporary cursor. The numeric edge stack can retain its high-water capacity, bounded by tree depth. |
| Lazy tree metadata | Three typed arrays are allocated when term reconstruction needs them, bounded by the tree. They live with the index. |
| External ID lookup | Identity numeric IDs avoid retaining an ID array. Other IDs use a lazy map bounded by document count. Factories already separate closure contexts to avoid retaining the unused identity-mode array. |
| Tokenizer cache | The module-level Unicode delimiter memo has a finite code-unit domain, about 64 KiB at maximum, plus the Latin-1 table. |
| Stored fields and object IDs | Explicitly requested stored values and object IDs remain reachable for the index lifetime. Nested stored values are shared with results; retaining those results can retain their payloads by design. |
| Binary ownership | Raw and compressed loads copy packed typed arrays away from wire/decompression allocations. Sampled input backing buffers were collected while loaded indexes remained alive. |
| Binary failures | Node codec paths clean up streams and section references on errors. Repeated successful and corrupt raw/zlib/zstd loads left no active resources in the audit process. |
| Async ingestion | The builder is scoped to `fromAsyncIterable`; `for await` handles iterator termination on a body failure. There is no module-level owner of previous builders or indexes. An application that keeps an unfinished builder intentionally keeps its partial index. |

## Measurements and validation

[MEMORY_AUDIT_RESULTS.json](./MEMORY_AUDIT_RESULTS.json) records raw samples,
fixture hashes, bundle/source hashes and validation metadata. Memory values below
are MiB (2^20 bytes). Tests used Node 24.19.0; this is not a production soak test or
a guarantee covering every runtime and application callback.

The standalone harness loaded seven checked-in medication fixtures containing
**94,666 documents**, ran **1,800 searches** across unbounded/limited/paged search,
suggestions, wildcard and filtered searches, then reloaded all seven indexes six
times. It also exercised 36 synthetic async binary round trips and 36 corrupt
loads across raw/zlib/zstd: **85 successful loads** in total. Result digests match
between the published and patched packages. All **85 retired indexes**, **72
sampled result arrays** and tracked source backing buffers were collected.

| Patched run, after explicit GC | Heap used | External | RSS |
| --- | ---: | ---: | ---: |
| Fixtures loaded | 9.43 | 8.96 | 65.75 |
| Search batch 1 | 9.95 | 8.96 | 219.53 |
| Search batch 6 | 9.98 | 8.96 | 220.56 |
| Reload 1 | 10.22 | 8.96 | 248.81 |
| Reload 6 | 10.31 | 8.96 | 258.79 |
| All fixture indexes dropped and binary cycles completed | 6.61 | 2.04 | 259.63 |

RSS stays elevated while heap usage falls and weak references confirm object
collection. This demonstrates why retained allocator/V8 pages and transient peaks
must be distinguished from live application data. The small between-process RSS
difference is not evidence of a performance improvement from these fixes.

Validation on the final source:

- Build, TypeScript and ESLint passed; public bundle and internal-boundary checks passed.
- **741 tests in 42 files passed**, with current local BDPM exports supplied to the
  optional corpus tests (146,489 source documents across ten datasets; distinct
  from the older binary fixtures used by the standalone harness).
- **36 runtime tests passed** against the ESM, CJS and browser bundles on Node 24.
- **255 REST tests in 28 suites passed**, including slow tests, with a temporary
  Jest alias to the patched CJS bundle. The REST dependency/lockfile was not edited.
- A targeted `extreme-giantVocabulary` search workload passed after the cursor
  change. It is a workload check, not a controlled speed comparison.

## Reproduction

From this repository, using Node 24 and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test
pnpm test:runtime
node --expose-gc benchmarks/scripts/audit-memory-retention.cjs \
  dist/cjs/index.require.cjs tmp/memory-audit/fixed.json
```

For a before/after comparison, run the same harness in another process with its
first argument pointing to the installed 1.11.0 CJS entry and a different output
path. Both runs use the checked-in binary fixtures. To include optional current
BDPM corpus tests, set `CORPUS_EXPORT_DIR` to documents exported by the REST
repository's `src/scripts/export-corpus-documents.js` before running `pnpm test`.

The REST service currently uses published **1.11.0**. These library changes need
a library release and a dependency update before they affect its deployment.
Its current callbacks do not capture the full corpus, its stored fields are empty,
and its normal successful build path does not exercise the failed-builder defect.
Consequently, the defects are reproducible library issues, but have **not** been
established as the cause of the original 149 → 154 MB RSS observation.
