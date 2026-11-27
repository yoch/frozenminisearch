# Compiling with Bun `--aot` (experimental)

Bun can compile TypeScript/JavaScript to machine code at build time. This note explains how to try it with FrozenMiniSearch and what we measured. It applies to **standalone Bun executables** only: Node, browsers and Bun without `--aot` keep using the Rollup bundles.

The latest measurements use `1.4.6-canary.1+25c4fca9e` on the `docs/bun-aot` branch after the `1.13.0` merge. On `1.4.6-canary.1+736fe1187` the static checks, the tests and the issue repros were re-run, without timings (the host was under load); `bun compile --library` emits the same `index.aot.ts`, byte for byte, as on `25c4fca9e`. The historical runs cover the [compiler rewrite in oven-sh/bun#47942](https://github.com/oven-sh/bun/pull/47942), which first landed in `1.4.4-canary.1+2596ac5d3`. Canaries `8aa496e1d` and `ed4363334` recovered much of the query throughput and executable size. The last pre-rewrite run used `7ca0042d3`. See [Measurements](#measurements).

## Commands

| Command | Effect |
|---------|--------|
| `bun --aot app.ts` | Type-checks like `bun compile`, then runs with built-in objects read-only. **No speed-up.** Useful as a guard. |
| `bun build --compile --aot app.ts --outfile app` (or `bun compile app.ts`) | Real AOT: standalone executable with machine code. |
| `bun build --compile --no-aot app.ts --outfile app` | Classic bundle + JIT executable (baseline). |
| `bun compile app.ts --outfile app --explain` | Lists static slow-path causes. `--explain=json` lists all causes. `allocations`, `guards`, `guards-json` and `trim` are other reports. |
| `bun check --aot --explain app.ts` | The same report without building. |
| `bun test --aot src/ dev/parity/` | Compiles the tests and the code they import, then runs them. |
| `bun check --no-script` | Type check. AOT needs a type-correct program. |

`bun --aot-log-type-mismatches` and `--explain=missed-optimizations` no longer exist since the rewrite. Before it, the first one found two declared-type mismatches in this repo (fixed in `src/frozenBuild.ts` and `src/scoring.ts`). `25c4fca9e` accepts `--explain=forms` for machine-code forms and sizes and `--explain=statistics` for compiler counters. See the [Bun explain guide](https://bun.com/docs/compiler/explain).

On `736fe1187` and `25c4fca9e`, `bun test --aot --timeout=30000 ./src ./dev/parity` passed all 880 tests across 49 files. The preceding `9990f3d48` run also passed 880 tests with `--parallel`. On `8aa496e1d` (pre-`1.13.0`), all 845 tests across 47 files passed.

## Distributing the library

AOT code lives in the **executable**, not in a package. What a package can ship is its typed source behind an `"aot"` export condition, which `bun build --compile --aot` selects by itself (no `--conditions` flag). Without the types, the compiler takes slow paths through the plain JavaScript bundle.

The package does this:

- `make build` runs `scripts/build-aot-source.cjs`, which calls `bun compile --library src/index.ts` and keeps only its `index.aot.ts`, written to `dist/aot/index.aot.ts` (about 250 KB) with the Bun version in its header. The `index.js`, `.d.ts` files and `package.json` that `--library` also emits are dropped: Rollup and the root `package.json` already provide them. Only the Node entry has an AOT source; `./browser` has none.
- `package.json` lists `"aot": "./dist/aot/index.aot.ts"` first in the `.` export, because resolvers take the first matching condition. `scripts/verify-npm-pack.cjs` checks this order and that every export target is in the tarball; `scripts/assert-public-bundles.cjs` scans the file like the other bundles.
- `make test-aot` (`dev/aot/run.mjs`) packs the build, installs it outside the repository and compiles two consumers with `--aot`: [`consumer.ts`](../aot/consumer.ts) (typed ESM) and [`consumer.cjs`](../aot/consumer.cjs) (untyped CommonJS with `require`, shaped like `fr.gouv.medicaments.rest`: `fromAsyncIterable`, the builder, `AND`, `matchIds`, function-valued `prefix`/`fuzzy`, custom `tokenize`/`processTerm`, `filter`, `limit`, `matchInfo: false`). It fails:
  - if Bun reports a type error in `index.aot.ts`, or compiles it without its types;
  - if an `--aot` build, ESM or CJS, did not resolve the `"aot"` condition;
  - if `bun build --compile --no-aot`, plain `bun build --target=bun` or the Bun runtime (`import.meta.resolve`, `require.resolve`) resolves anything but `dist/es` and `dist/cjs`;
  - if an executable's results differ from the same consumer under Bun JIT, bit for bit, across `fromDocuments`, the builder, `fromAsyncIterable`, `fromJSON` and every binary compression.

  On a Bun without `--aot` it prints that it skipped and succeeds (a warning annotation in GitHub Actions), unless `REQUIRE_AOT=1`, which `prepublishOnly` sets so that a release cannot skip it. CI runs it on Bun `latest` and `canary`; a failure on `canary` is reported without blocking the merge. `prepublishOnly` runs it before every release.
- `make build` needs Bun on `PATH` (as `make lint` already does) and fails with a message otherwise. `scripts/verify-npm-pack.cjs` also checks that the `"aot"` target carries the generated header, so a release cannot ship without it or with a hand-edited file. The header records the Bun that generated it: the CI `test` job uses `canary` until `bun lint` is in a stable release, then that release should be pinned, which also pins the AOT source.

### Using the library from another project

Install the package as usual. Nothing in the consumer selects the AOT source except `bun build --compile --aot` (or its short form `bun compile`):

| Consumer | Resolves |
|----------|----------|
| `bun build --compile --aot`, `import` or `require` | `dist/aot/index.aot.ts` |
| `bun build --compile --no-aot`, `bun build`, the Bun runtime (`bun run`) | `dist/es` (`import`) or `dist/cjs` (`require`) |
| Node, browsers, bundlers | `dist/es`, `dist/cjs`, `dist/browser`, as before |
| TypeScript (`nodenext`, `node16`, `bundler`) | `dist/es/index.d.ts` |

These were checked on `736fe1187`. The consumer does not need `--conditions=aot`, `@types/node` or typed code of its own: an untyped CommonJS service still gets the typed library (in `consumer.cjs`, 50.1 % of dependency accesses compile to one load, against 50 % for the typed consumer).

- **Opting out.** `--conditions` adds conditions but cannot remove `"aot"` (`--conditions=node` and `--conditions=import` still resolve `index.aot.ts`). If a Bun release miscompiles the library, build with `--no-aot`: the executable then embeds `dist/es` or `dist/cjs` and runs under the JIT.
- **Hot path.** Pass `matchInfo: false` to `search` when results are shown without `terms` and `match`. It was the largest single gain measured under AOT (see the table below).
- **`--trim`.** Use `--trim` and `--trim-locales=<list>` rather than `--trim-without`, whose names differ from those printed by `--explain=trim` ([#47919](https://github.com/oven-sh/bun/issues/47919)). The library imports `node:zlib` (binary snapshot compression), which keeps about 14 MiB more than a hello world after trimming ([#47920](https://github.com/oven-sh/bun/issues/47920)). On `736fe1187`, `--explain=trim` no longer attributes `Intl` to the library: only `Intl.Locale`, `PluralRules` and `RelativeTimeFormat` are removed, and a consumer that needs `Intl.Collator` keeps it with `--trim-locales`.

### Type errors in the AOT source

Bun reports type errors inside a dependency only when a build has other diagnostics, and then compiles the whole package without its types, which still works but runs slower. `make test-aot` therefore also compiles a probe with a deliberate type error. Earlier, inside `node_modules`, Bun's checker rejected `node:stream` classes such as `Transform` as types (TS2709) while `bun check` in the repository accepted them, so stream types in `src/msv5/binaryMsv5Compression.ts` are derived from `node:zlib` instead; on `8aa496e1d`, `import type { Transform } from 'node:stream'` inside `node_modules` no longer triggers TS2709 (with or without `@types/node`), though keeping the `node:zlib`-derived type avoids the dependency altogether. Bun checks the AOT source under the `compilerOptions` of the package's `package.json`, or as `strict` when there are none (our case, and `tsconfig.json` is strict too).

Before the rewrite, with the same consumer compiled with `--aot` on the Divina Commedia x3, the `"aot"` condition made exact, prefix and fuzzy search, `AND`, `autoSuggest` and `searchPage` 1.8-2.8x faster than the plain JavaScript bundle. On `2596ac5d3` that gain shrank to 0-25 %. On `8aa496e1d`, the `"aot"` condition again beats the plain JavaScript bundle on every metric (by 11 % on build and 21-29 % on queries; see below). Results are identical in both cases. Against Node, ids and ordering are identical; some scores differ in the last bit (relative difference up to 5e-16), as they already do between Bun JIT and Node (JavaScriptCore and V8 math functions).

## Measurements

The speed suites use Divina Commedia x3 (42,291 documents, one indexed and stored `txt` field), `fromDocuments`, then `saveBinarySync` / `loadBinarySync` (1.7 MB). Queries run on the reloaded index. The tables use the median of five process runs, taking the fastest of five passes per metric within each process. The query sets differ across versions.

### Measurements with `1.4.6-canary.1+25c4fca9e`

The November 22 run used Linux x64 on an Intel Core i7-3770 and Node 24.18.0. It used the packed FrozenMiniSearch 1.13.0 distribution and a 1,747,243-byte snapshot. The speed suite rotates the order of the modes and pins processes to a physical core with both SMT siblings. Other processes shared the machine. Small differences need another run under quieter conditions.

| Metric (µs/op unless noted) | Node 24 | Bun JIT | Bun `--aot` script | Compile `--no-aot` | AOT, JS bundle | AOT, typed export | AOT, `--trim` | Typed AOT vs. `--no-aot` |
|-----------------------------|--------:|--------:|-------------------:|-------------------:|---------------:|------------------:|----------------:|-------------------------:|
| Build (ms) | 201 | 261 | 218 | 213 | 253 | 192 | 192 | -10% |
| Save + load (ms) | 261 | 183 | 165 | 171 | 194 | 176 | 181 | +3% |
| Exact | 100.6 | 93.1 | 75.7 | 94.2 | 100.2 | 93.1 | 83.1 | -1% |
| Prefix | 487.0 | 503.1 | 421.9 | 438.5 | 532.1 | 419.6 | 409.2 | -4% |
| Fuzzy | 223.1 | 258.4 | 221.4 | 219.2 | 322.0 | 222.8 | 245.5 | +2% |
| OR, five terms | 203.3 | 178.9 | 180.9 | 197.8 | 164.7 | 148.7 | 147.8 | -25% |
| Broad OR, `limit: 10` | 25,237.8 | 21,914.3 | 20,850.1 | 20,870.8 | 22,231.0 | 20,024.1 | 20,707.9 | -4% |
| AND | 53.7 | 47.9 | 47.1 | 47.3 | 49.2 | 41.1 | 41.4 | -13% |
| `autoSuggest` | 347.5 | 316.5 | 248.7 | 255.0 | 349.7 | 259.5 | 251.1 | +2% |
| `searchPage` | 121.5 | 141.3 | 115.3 | 118.4 | 141.4 | 120.9 | 113.0 | +2% |
| Nested combination | 62.9 | 56.0 | 50.1 | 58.6 | 49.9 | 42.6 | 42.3 | -27% |

Exact and fuzzy cycle through `amore`, `stelle`, `virtute`, `paradiso`, `dolore`, `occhi`, `mondo`, `luce`, `cielo` and `anima`. Prefix takes the first three characters and `autoSuggest` takes the first four. Fuzzy and `autoSuggest` use a distance ratio of 0.2. The compact OR uses the first five of those words and the broad OR uses `e la che per non di`. The AND uses `amore cielo`, and the page uses `amore luce` (offset 5, limit 10).

On this workload, the most consistent AOT gains were build (10% lower median, faster in all five rounds) and five-term OR (25% lower, faster in all five). Nested search fell 27% and AND 13%, with gains in four of five rounds. Exact, prefix, fuzzy, broad OR, suggestions, pagination and save + load landed within 4% of `--no-aot` at the median. The typed export beat the JavaScript bundle under AOT on all eleven medians.

The exact-search follow-up uses the same prebuilt snapshot in both executables. Three processes per mode, 6,000 calls after 1,000 warmup calls, pinned to one logical CPU.

| Exact query | All hits | `--no-aot` (µs/op) | Typed AOT (µs/op) |
|-------------|---------:|-------------------:|------------------:|
| `amore` | 168 | 133.0 | 98.1 |
| `amore`, limit 10 | 168 | 54.1 | 39.1 |
| `come` | 1,896 | 1,663.8 | 1,621.1 |
| `come`, limit 10 | 1,896 | 662.1 | 718.3 |

AOT was 21–29% faster for `amore` with or without the limit in every round. For `come`, the direction varied across rounds. The medians for that term give an indication of latency on this machine.

The throughput executable measured **150.7 MiB** with `--no-aot`, **68.7 MiB** with typed AOT and **39.7 MiB** with `--trim`. The parity consumer was 68.9 and 40.2 MiB with typed AOT and with trim, respectively, and both builds passed the same checks. The typed source is 250.2 KiB. A hello-world executable measured 150.5 MiB with `--no-aot`, 65.3 MiB with AOT and 24.1 MiB with trim. Calling `gzipSync` from `node:zlib` raises the trimmed hello-world size to 38.4 MiB. The consumer's trim report shows that it retains Brotli, zstd and all locales.

RSS in MiB over two runs per mode, with 200,000 exact, prefix and fuzzy searches drawn from eight terms. Forced GC runs after load and every 50,000 queries. Peak RSS is sampled every 1,024 queries and at the end of each batch.

| Phase | Bun JIT | `--no-aot` | Typed AOT |
|-------|--------:|-----------:|----------:|
| After index load and GC | 53.8–54.0 | 51.4–52.6 | 43.3 |
| After GC, 50k–200k queries | 59.3–60.8 | 57.3–58.6 | 45.1–46.6 |
| Peak sampled during searches | 93.9–94.7 | 91.6–92.9 | 74.2–74.9 |

#### `--explain` and optimization candidates

**Last pass, `736fe1187`.** The parity consumer reports **592 causes** and the same dependency accesses as on `25c4fca9e` (1,344 free, 895 tested, 446 by name, 50 %); the ranking of library causes is unchanged (`Object.assign` in the OR merge first, then `JSON.parse`, the options spread and `collectDocIdsForQueryInternal`). `guards-json` still emits 1,197 records. The CommonJS consumer reports 585 causes with 1,340 free, 889 tested and 443 by-name dependency accesses (50.1 %), so `require` loses nothing. `inspect-index-typing.cjs --suspect-only` still finds zero suspect components (488 numeric, 35 string/symbol-keyed). With nothing new to act on and no timings possible, no code change came out of this pass; the candidates below stand.

Before the scoring-weight hoist, [the parity consumer](../aot/consumer.ts) had **591 causes** and **50.0% fixed-offset dependency accesses** (1,344 free, 895 tested, 446 by name) in an external project with the packed dependency installed. These counts match `9990f3d48`. Building the same consumer from the checkout's scratch directory gave 588 causes and 893 tested accesses. The external-project counts are the historical comparison.

`guards-json` emitted 1,197 guard records, of which 86 lead to the function's slow version if the guard fails. `allocations` emitted 841 records, of which 217 were marked as removed. `forms` counted 5,182 `TypeTest` sites and 1,020 `GetTypedArrayElement` sites in the generated code. These are static compiler records. Use profiles to establish which paths run frequently. The source index audit (`node dev/scripts/inspect-index-typing.cjs --suspect-only`) found zero suspect components across 488 numeric accesses and 35 string/symbol-keyed accesses.

| Workload | Largest AOT self-time samples | What the report suggests checking |
|----------|-------------------------------|-----------------------------------|
| `come`, all 1,896 hits | `scorePostingDoc` 23%, `sort` 14%, `finalizeSearchResults` 11%, `assignStoredFields` 11%, `byScore` 9% | The report flags the sort call and result writes. Finalization, sort and comparator account for about 34% together, with stored-field assignment another 11%. |
| `come`, `limit: 10` | `scorePostingDoc` 42%, `keyedSingleMatch` 14%, `aggregateSegmentPostingList` 10%, `calcBm25TfWithConstants` 8% | Scoring still visits the postings and builds match metadata for candidates. The report flags `Map.get` and `Map.set` in the scoring loop and loses provenance on the field-length view in the throughput harness. |
| Broad OR, `limit: 10` | `scorePostingDoc` 29%, OR merge 28%, `keyedSingleMatch` 15%, `assignUniqueTerms` 9% | The first dependency cause in the parity consumer is `Object.assign(existing.match, match)` in the OR merge, with 58 affected accesses and 20 sites in loops. Bun associates it with `DocIdBitSet`, although the assignment target is a `MatchInfo` object. Treat the reported class attribution as suspect. |
| Fuzzy `vertute`, distance ratio 0.2 | `scorePostingDoc` 16%, `exactSuffixMatches` 16%, `keyedSingleMatch` 8%, `visitBits` 7% | The report flags the visitor call and path writes. A separate optimization here would need to reduce work in the fuzzy traversal or suffix comparison. |

Read `why` as the compiler's explanation for a loss of information and `uses` as the list of affected static sites. For a proposed fix, check whether those uses execute on the relevant workload. The profiler measures the cost of a function including its other operations. A guard record shows where a check may fail, with no failure frequency. [Bun's guide to the report](https://bun.com/docs/compiler/explain).

##### Which causes can be addressed locally

**Scoring.** The `builtin-property` and `many-functions` reports at `results.get(docId)` and `results.set(docId, …)` describe method resolution on a `Map`. The type of the map is already `Map<number, RawResultValue>`. The two reports at the optional boost callback concern caller-supplied code and apply when that option is present. The three weights `termWeight`, `termBoost`, and `fieldBoost` stay constant for an entire posting list. Computing their product once preserves multiplication order through `postingWeight * docBoost * rawScore`. The callback, its early return, and BM25 evaluation keep their order. [Scoring and posting loops](../../src/scoring.ts).

In the initial scratch run, calculating the product separately in the segment and generic paths reduced the AOT median for `come` with `limit: 10` by 7.6% (383.7 to 354.4 µs). A fresh build of both versions from the same external project, with the same inputs and executable path, reversed the result. The median rose from 344.5 to 427.2 µs (+24.0%) for top 10 and from 660.9 to 748.2 µs (+13.2%) for all hits. Both workloads were slower in all five rounds.

The selected version computes the product in `aggregateTerm` before selecting the posting path. This also reduces the segment function's argument count. In the same five-round AOT test, this version took 332.5 µs for top 10 (−3.5%) and 665.3 µs for all hits (+0.7%). A separate three-pair test saw gains of 4.2% on top 10 and 4.8% on fuzzy `vertute`, with the five-term OR within 1%. On the rebuilt package's JS bundle, five pairs gave −8.7% for top 10 and −6.9% for OR in Bun JIT, and +1.2% and −4.2% respectively in Node. Fuzzy was within 1% in both runtimes.

**Match objects and OR.** The highest-ranked library cause is `changed-shape` at `Object.assign(existing.match, match)`. Terms are runtime keys, so each merge can grow a `MatchInfo` object. Bun attributes 58 accesses and 20 loop sites to the cause, with uses across scoring, fuzzy traversal, stored fields, and other modules. One use maps to `docIdBitSet.ts`. The assignment target is the match object. Initializing `DocIdBitSet._ids` explicitly left the same report and totals. Replacing both merge assignments with explicit key copies cleared that message and increased the totals to 514 / 345. Iterating OR's incoming map entries lowered by-name accesses to 336, cut the five-term OR median by 3%, and raised the broad OR median by 11%. The existing `matchInfo: false` option takes the match allocation out of the posting loop and avoids collecting its keys during result materialization. It keeps `queryTerms`, scores, result order and stored fields. Filters that read `terms` or `match` need the full result shape. [OR merge and match construction](../../src/scoring.ts), [search overloads](../../src/FrozenMiniSearchCore.ts).

**Stored fields and result finalization.** The `checked-element` reports for `layout.values[shortId]` and `layout.rows[shortId]` are legitimate. Stored rows can be missing and short IDs are read in result order. The existing `undefined` checks keep absent fields absent. The dynamic write `target[layout.field]` reflects a user-chosen field name. The `Object.defineProperty` path preserves `__proto__` as an own field. Fixed result shapes would alter the public result contract. On a separate line, `results[write++] = result` gets a bounds check because the compiler cannot prove that iteration of the map matches the original allocation. Appending with `push` clears the entry. The sort reports concern builtin dispatch, and the current sort preserves iteration order when scores tie. [Stored-fields layout](../../src/storedFieldsLayout.ts), [result finalization](../../src/scoring.ts).

**Typed-array access and fuzzy traversal.** The scoring harness reports `lost-track / property-read` at the field-length view captured in `getFieldLength`. The index operands are numeric. Specializing the stride to one in the constructor cleared that entry and produced `unknown-callee / many-functions` at the call in `scorePostingDoc`, where there were now two possible callees. The whole report moved from 494 / 341 to 496 / 342. In the fuzzy walker the checks at `path.edges[depth] = ei` concern a reusable JS array that grows with the path. The visitor is supplied as a callback. In the fuzzy profile `exactSuffixMatches` accounts for 16% of self-time, and its hot work is reading and comparing labels. Caching the existing column references is local. Changing the path representation or the callback interface would affect other walkers and callers. [Field-length lookup](../../src/FrozenMiniSearchCore.ts), [fuzzy walker](../../src/PackedRadixTree/fuzzy.ts), [shared path](../../src/PackedRadixTree/termPath.ts).

**Import, options and ID-only queries.** `JSON.parse` has 27 affected accesses and 12 loop sites because objects from MiniSearch JSON have runtime shapes. Validation already checks the snapshot before materializing the frozen layout. Rebuilding the parsed objects solely for specialization would add an intermediate allocation on the import path. The MSv5 search workload bypasses that path. The options spread has 21 affected accesses and eight loop sites. Replacing it with `??` would change explicitly passed `undefined` or `null` overrides, and replacing it by direct reads changes which properties and getters are read. The `collectDocIdsForQueryInternal` report follows a factory returning `Set` or `DocIdBitSet`. These two implementations use different iteration orders and the bitset supports word-wise operations. This report is relevant to ID collection and query gates. The zlib CRC diagnostic is on binary I/O, and both named and default import probes still report an indirect call. The default import also preserves the fallback on early Node 20 releases. [JSON import](../../src/fromMiniSearch.ts), [option handling](../../src/scoring.ts), [ID collection](../../src/queryEngine.ts), [CRC compatibility](../../src/binaryIo.ts).

The focused checks used the same snapshot and five rotating process runs on one logical CPU. The AOT medians below compare each change to its workload's baseline. The four code variants matched all 12 packaged-consumer digests, and the reduced-output call matched the full result after dropping `terms` and `match`.

| Local change | Causes / by-name accesses | Timing and decision |
|--------------|--------------------------:|---------------------|
| Call `search` with `matchInfo: false` | Same binary | `come` fell from 723.8 to 563.5 µs (−22%). With `limit: 10`, it fell from 351.9 to 277.8 µs (−21%). It was faster in all five pairs on both workloads. Use where the consumer needs the reduced result shape. |
| Build the match object with a computed-key literal in `keyedSingleMatch` | 494 / 340 | Full AOT search improved 1.7% and top-k slowed 3.1%. Node 24 slowed 10% on full `come` and 29% at `limit: 10`. Keep the existing keyed assignment and its special case for `__proto__`. |
| Use `push` in the unfiltered finalizer | 493 / 341 | Full `come` improved 0.7% under AOT. The bounds diagnostic disappears, with negligible AOT impact on this workload. A second check measured improvements of 4.6% on Node and 7.3% on Bun JIT for full `come`, and a 9.9% slowdown on Bun JIT for full `amore`. |
| Select a stride-one field-length closure for single-field indexes | 496 / 342 | Full `come` slowed 6.7% and top-k slowed 10.1%. This variant changes both address arithmetic and call dispatch. |
| Cache the edge and leaf columns in the fuzzy walk and suffix test | 494 / 340 | The six-term fuzzy workload slowed 8.5%, with a slowdown in all five pairs. The two path-array element checks remain. |

The rebuilt typed export matches the selected trial source byte for byte. The external parity consumer reports 592 causes and the original dependency access counts. All 12 packaged checks and 48 queries with fractional term, field and document boosts matched the baseline in AOT and Bun JIT. The 48 queries also matched the preceding revision under Node. Callers can pass `matchInfo: false` when presenting results without match details.

The run directories of that round were local scratch and are not kept. To collect comparable diagnostics, run `KEEP_AOT_CONSUMER=1 make test-aot`, which keeps the installed consumer outside the checkout, and run `bun build --compile --aot --explain=json consumer.ts --outfile consumer` there with [the parity consumer](../aot/consumer.ts). Repeat with `--explain=guards-json` and `--explain=allocations`. To profile the standalone search loop, set `BUN_OPTIONS="--cpu-prof"` when launching it.

### Speed with `1.4.5-canary.1+ed4363334` (µs/op unless noted)

Measured before merging `1.13.0` onto `docs/bun-aot`, using a separate scratch query set (`build` / `save+load` best of 5 passes, queries averaged over 10 exact/prefix/fuzzy/autoSuggest or 5 OR/AND/searchPage terms; compare columns, not tables).

| Metric | Node 24 | Bun JIT | `bun --aot` (script) | compile `--no-aot` | `--aot`, JS bundle | `--aot`, `"aot"` condition | `--aot --trim` | `--aot` vs `--no-aot` |
|--------|--------:|--------:|---------------------:|-------------------:|-------------------:|---------------------------:|---------------:|----------------------:|
| build (ms) | 164.9 | 190.6 | 200.1 | 201.2 | 182.7 | 150.0 | 153.5 | -25 % |
| save+load (ms) | 323.2 | 167.6 | 168.0 | 167.7 | 189.2 | 174.3 | 175.0 | +4 % |
| exact | 106.2 | 96.3 | 107.1 | 98.7 | 109.2 | 79.2 | 78.6 | -20 % |
| prefix | 272.5 | 273.1 | 269.9 | 268.2 | 308.0 | 223.6 | 228.1 | -17 % |
| fuzzy | 274.6 | 261.0 | 263.3 | 261.1 | 312.2 | 216.4 | 219.0 | -17 % |
| multi-term OR | 234.3 | 218.4 | 226.0 | 215.7 | 236.8 | 178.0 | 176.1 | -17 % |
| multi-term AND | 56.2 | 51.9 | 49.6 | 50.3 | 58.6 | 38.3 | 38.6 | -24 % |
| autoSuggest | 1599.8 | 1199.3 | 1181.0 | 1202.7 | 1507.3 | 1090.6 | 1104.9 | -9 % |
| searchPage | 136.1 | 133.1 | 127.0 | 131.5 | 164.7 | 110.4 | 108.9 | -16 % |
| nested combination | 124.3 | 118.1 | 118.6 | 118.3 | 143.2 | 99.8 | 101.0 | -16 % |

With `1.4.5-canary.1+ed4363334`, `--aot` with the `"aot"` condition beats `--no-aot` and Node 24 on every query metric including `fuzzy` (`-17 %`, up from parity on `8aa496e1d`), and beats the `--aot` JS bundle by `18–33 %`. `save+load` is near parity with `--no-aot` (`+4 %`) and `1.85x` faster than Node 24. `--aot --trim` keeps the same speed while trimming the executable from `69.1` to `40.0 MiB` (`150.2 MiB` for `--no-aot`).

Targeted checks on `1.4.5-canary.1+ed4363334`:

- **Standalone `Map` / `Set` / object / `sort` microbenchmarks (2,000 entries, 10k calls, `sort` 1k calls, `taskset -c 0`, minimum of 3 runs)**: `map-get` with an `Int32Array` key now reaches parity with `--no-aot` (`76.8` vs `77.1 ms`, improved from `1.45x` slower on `8aa496e1d`), while `--aot` remains faster on `map-iter` (`79.9` vs `328.0 ms`, `4.11x`), `set-iter` (`64.0` vs `74.4 ms`, `1.16x`), object creation (`279.5` vs `813.5 ms`, `2.91x`), `sort` (`62.0` vs `305.7 ms`, `4.93x`), and full finalization (`534.4` vs `886.4 ms`, `1.66x`).
- **100,000 exact searches pinned to one core (`taskset -c 0`, minimum of 3 runs)**: `"amore"` (168 hits) is slightly faster under `--aot` (`52.3` vs `55.4` µs, `-6 %`; `limit: 10`: `40.0` vs `33.4` µs, `+20 %`), while `"come"` (1,896 hits) is slower than `--no-aot` (`736.6` vs `690.1` µs, `+7 %`; `limit: 10`: `418.9` vs `317.8` µs, `+32 %`), as `--no-aot` improved over `8aa496e1d` on this tight loop while `--aot` slowed down.
- **`--explain` on `dev/aot/consumer.ts`**: `562` causes on `ed4363334` (pre-`1.13.0`), with `435` by-name dependency accesses and `49.4 %` of dependency accesses compiled to one fixed-offset load (`1,307` free, `899` tested, `435` by name). On `1.4.5-canary.1+9990f3d48` after merging `1.13.0`: `591` causes and `50 %` one-load dependency accesses (`1,344` free, `895` tested, `446` by name); `node dev/scripts/inspect-index-typing.cjs --suspect-only` still reports `0` suspect index accesses (`488` numeric, `35` string/symbol-keyed). Speed timings were not re-measured on `9990f3d48` because the host was under heavy CPU load.

### Speed with `1.4.4-canary.1+8aa496e1d` (µs/op unless noted)

| Metric | Node 24 | Bun JIT | `bun --aot` (script) | compile `--no-aot` | `--aot`, JS bundle | `--aot`, `"aot"` condition | `--aot --trim` | `--aot` vs `--no-aot` |
|--------|--------:|--------:|---------------------:|-------------------:|-------------------:|---------------------------:|---------------:|----------------------:|
| build (ms) | 226.6 | 208.6 | 217.9 | 239.5 | 166.4 | 147.7 | 155.7 | -38 % |
| save+load (ms) | 303.1 | 169.1 | 175.1 | 173.1 | 156.2 | 155.3 | 157.0 | -10 % |
| exact | 26.7 | 32.2 | 28.1 | 27.9 | 28.2 | 22.3 | 22.5 | -20 % |
| prefix | 122.0 | 105.6 | 107.1 | 105.7 | 107.7 | 84.5 | 85.8 | -20 % |
| fuzzy | 45.3 | 40.8 | 41.4 | 41.5 | 58.1 | 41.0 | 40.7 | ~ |
| multi-term OR | 157.7 | 126.1 | 135.4 | 126.9 | 138.8 | 107.5 | 109.2 | -15 % |
| multi-term AND | 50.1 | 35.4 | 35.1 | 34.9 | 43.2 | 32.5 | 32.2 | -7 % |
| autoSuggest | 144.6 | 121.2 | 119.9 | 115.5 | 143.8 | 105.0 | 105.2 | -9 % |
| searchPage | 49.7 | 42.4 | 43.7 | 40.5 | 48.4 | 37.9 | 36.6 | -6 % |
| nested combination | 67.3 | 49.4 | 49.2 | 47.5 | 56.0 | 39.8 | 38.3 | -16 % |

On `8aa496e1d`, `--aot` with the `"aot"` condition **beats `--no-aot` and Node 24 across the board** (with `fuzzy` at parity with `--no-aot` and faster than Node 24). `--aot --trim` runs at the same speed while cutting executable size nearly in half, and `bun --aot` (script mode) remains at JIT speed.

Re-checking the earlier regression cases on `8aa496e1d`:

- **100,000 exact searches pinned to one core (`taskset -c 0`, minimum of 3 runs)**: `--aot` now beats `--no-aot` even on common words where `finalizeSearchResults` dominates — `"amore"` (168 hits): `44.8` vs `56.2` µs (-20 %, `limit: 10`: `33.4` vs `31.6` µs); `"come"` (1,896 hits): `618.1` vs `865.5` µs (-29 %), `limit: 10`: `334.7` vs `426.6` µs (-22 %).
- **Standalone `Map` / object / `sort` microbenchmarks (2,000 entries, 10k calls, `sort` 1k calls, `taskset -c 0`)**: `--aot` is `3.36x` faster than `--no-aot` on `Map` iteration (`88.9` vs `298.4` ms), `1.78x` faster on object creation (`690.6` vs `1229.5` ms), `3.28x` faster on sorting (`86.5` vs `284.0` ms), and `2.17x` faster on full finalization (`2011.2` vs `4364.4` ms). Only `Map.get` remains slower under `--aot` (`183.2` vs `126.5` ms, `1.45x`, improved from `2.6x` on `2596ac5d3`).
- **CPU profile (`BUN_OPTIONS="--cpu-prof"`) on 100,000 `"come"` searches**: `scorePostingDoc` `32.5 %`, `sort` `11.1 %`, `keyedSingleMatch` `9.8 %`, `byScore` `7.8 %`, `finalizeSearchResults` `7.3 %` (`finalizeSearchResults + sort + byScore` = `26.2 %`, down from `57 %` on `2596ac5d3`).
- **`--explain` on `dev/aot/consumer.ts`**: `563` causes (down from `2,704` on `2596ac5d3`), `439` by-name dependency accesses (down from `1,569`), and `49.7 %` of dependency property accesses compiled to a single fixed-offset load (`1,326` free, `900` tested, `439` by name; up from `28 %`).
- **Index expressions and `ArrayBufferLike` views**: `a[(offset + i) | 0]` matches `a[offset + i]` (`167.4` vs `171.1` ms under `--aot`, vs `190.4` / `187.4` ms under `--no-aot`), and `a[b[i] % a.length]` no longer triggers `loose-type` (`393.2` vs `346.9` ms, +13 % instead of 7.6x). Passing a `new Uint32Array(buf, 0, 2)` view over `ArrayBufferLike` across an exported non-inlined call now keeps `a[i]` typed (`free`): only `a.length` inside the loop condition warns (`read it outside your loops`), and hoisting `const len = a.length` yields `100 %` typed accesses.

### Speed with `1.4.4-canary.1+2596ac5d3` (historical, µs/op unless noted)

Different scratch script and query set from the older table below (common Italian words, so the absolute numbers are higher); compare columns, not tables.

| Metric | Node 24 | Bun JIT | compile `--no-aot` | `--aot`, JS bundle | `--aot`, `"aot"` condition | `--aot` vs `--no-aot` |
|--------|--------:|--------:|-------------------:|-------------------:|---------------------------:|----------------------:|
| build (ms) | 209 | 220 | 219 | 193 | 177 | -19 % |
| exact | 82 | 73 | 75 | 157 | 149 | +99 % |
| prefix | 339 | 321 | 326 | 485 | 474 | +45 % |
| fuzzy | 179 | 175 | 177 | 297 | 287 | +63 % |
| multi-term OR | 32,546 | 26,146 | 26,868 | 31,707 | 29,475 | +10 % |
| multi-term AND | 46 | 42 | 43 | 67 | 54 | +24 % |
| autoSuggest | 254 | 210 | 222 | 428 | 402 | +81 % |
| searchPage | 98 | 96 | 102 | 173 | 135 | +32 % |
| nested combination | 51 | 44 | 47 | 63 | 54 | +16 % |

Since the rewrite, `--aot` is **slower** than `--no-aot` for every query; only indexing is faster. The same holds for a consumer of the packed package (`"aot"` condition resolved, no file compiled without types). An entry point outside the repository that imports `src/` by absolute path is not representative: Bun then compiles some of the library's files without their types.

#### Before and after the rewrite, on one script

The same `bench.ts`, the same corpus and the same built index, compiled by the last canary before the rewrite and by the first one after it:

- before: `1.4.4-canary.1+7ca0042d3` (npm `@oven/bun-linux-x64@1.4.4-canary.20261107.1`), the parent of `2596ac5d3`; it still has `--aot`;
- after: `1.4.4-canary.1+2596ac5d3`.

One hundred thousand exact searches on the reloaded index, three runs pinned to one core, minimum (µs/search):

| Query | before, `--aot` | after, `--aot` | before, `--no-aot` | after, `--no-aot` |
|-------|----------------:|---------------:|-------------------:|------------------:|
| exact | 65.0 | 165.4 | 81.7 | 81.8 |
| exact, `limit: 10` | 51.2 | 75.7 | 48.2 | 47.7 |

The two `--no-aot` executables are the same to noise, so the rewrite changed only the AOT side. With every match materialized and sorted, the new AOT is 2.5x the old one; with ten results, 1.5x. The extra ~90 µs per full query is in `finalizeSearchResults`: iterating the raw-result `Map`, creating one result object per document, copying the stored field, and sorting. That phase cost ~14 µs/query before and ~90 µs/query after, while the query and scoring path went from ~51 to ~76 µs. The regression is concentrated in finalization, not spread over all compiled code.

A standalone `finalizeSearchResults` benchmark (2,000 raw results, 10,000 calls, declared types and no `any`, minimum of three runs) points the same way:

| Mode | before, `--aot` | after, `--aot` | after, `--no-aot` |
|------|----------------:|---------------:|------------------:|
| full (materialize + sort) | 3.6 s | 8.8 s | 7.3 s |
| same, `skipSort` | 0.77 s | 1.87 s | 2.29 s |
| same, `limit: 10` | 0.54 s | 0.98 s | 0.76 s |

The new AOT is at JIT speed or slower on this path; the old AOT was 2-3x faster than JIT. The difference is the compiler, not the library's data.

Microbenchmarks of the operations inside that path (2,000-entry `Map`, fixed loops, minimum of three runs, ms):

| Operation | before, `--aot` | after, `--aot` | after, `--no-aot` |
|-----------|----------------:|---------------:|------------------:|
| iterate all entries | 13.6 | 126.7 | 168.3 |
| `Map.get` | 46.7 | 118.8 | 45.9 |
| create 2,000 result objects | 62.4 | 111.7 | 202.4 |
| sort 2,000 objects | 38.6 | 62.8 | 65.2 |

The new compiler still beats JIT on `Map` iteration and object creation, but it lost the old compiler's specialization: 9x slower than it on iteration, 2.5x on `Map.get`, and no faster than JIT on sorting. `Map.get` is 2.6x slower than JIT in the new AOT, the one micro-operation here where the AOT output is clearly worse; the typed full finalize benchmark above is also about 20 % slower than JIT. `perf stat` on the 100,000 exact searches counts 32.4 G instructions before, 112.2 G after, and 46.7 G for the new `--no-aot`; the new AOT runs 3.5x the old AOT and 2.4x the JIT, and its higher IPC does not make up the difference.

This is the trade-off the rewrite announced. The engine PR ([oven-sh/WebKit#997](https://github.com/oven-sh/WebKit/pull/997)) says builds are about ten times cheaper and the code smaller, but the output retires about 11 % more instructions and takes about 16 % longer on its TypeScript-compiler benchmark: "closing that is what is being worked on". It replaced the whole-program flow analysis and the B3/Air backend with a scan, a link, one walk and a small backend of its own, and notes that "several optimizations of the old compiler have their consumers in `codegen/` but no producer in `plan/` yet. They never fire today." Specialized `Map` iteration, `Map.get` and sorting are examples. Type tracking is also coarser: in each compiler's own report, `--explain` lists 531 causes before and 2,704 after, and by-name accesses rise from 336 to 1,569. But the finalize microbenchmark above is declared with precise types and is still 2.3x slower, so both the missing backend specialization and the lost type information contribute. Neither is a FrozenMiniSearch bug, and neither is worth working around on a compiler that is still being optimized.

`--explain` reports 28 % of the library's property accesses as typed. Read it with two things in mind:

- An index that may be `undefined` makes the access a lookup by name, which is correct JavaScript semantics: `counts[slot]++` on a local `Uint32Array` is slow when `slot` comes from a `number[]` element or from a typed-array read whose bounds the compiler cannot prove, and fast when it comes from an `Int32Array` read inside `i < ids.length`. Bun labels these `unknown-object` / `loose-type`, not `element-may-be-missing`, so the label points at the wrong cause.
- Nothing is measured: entries rank by static loop nesting, including methods that the program never calls (for example `_searchWildcardPage` in a benchmark without wildcard queries, whose `this` is then untracked). Only entries in functions on the measured path matter.

So the report is usable to tune hot loops, but such changes (proving bounds, coercing indexes) target the compiler of the day; measure each one, and keep it only if Node and Bun JIT are unaffected.

#### Where the time goes (`2596ac5d3`)

AOT executables accept the profiler: `BUN_OPTIONS="--cpu-prof --cpu-prof-dir=prof" ./app` writes a `.cpuprofile` with function names and source lines (`perf` sees no symbols). On a benchmark that runs only the exact search, `finalizeSearchResults` takes 50 % of the new AOT time and `scorePostingDoc` 17 %. Before the rewrite the same work was spread over `scorePostingDoc` (33 %), `sort` (16 %), `byScore` (10 %) and `finalizeSearchResults` (8.5 %). `finalizeSearchResults`, `sort` and `byScore` together were 35 % and 2.6 s before, 57 % and 10.4 s after. Under `--no-aot`, JavaScriptCore inlines more, so the same work is spread over `scorePostingDoc`, `newSearchResult` and `sort`.

What did not help (measured on the full benchmark, then reverted):

- typing `RawResult` maps as `new Map<number, RawResultValue>()` instead of `new Map() as RawResult`: same counts in `--explain`, same times;
- forms of the field-length index (`| 0` on either operand or on the sum, `?? 0`), or a cast to a single typed-array type: same times. Replacing the lookup with a constant halves exact-search time, but only because the BM25 arithmetic then folds: a varying value computed without memory access costs the same as the lookup. The TypeScript checker confirms that no index component is the problem: in all 485 numeric element accesses under `src/`, every component is `number`, with no `any`, `unknown` or possibly-`undefined` type. `node dev/scripts/inspect-index-typing.cjs --suspect-only` prints that check;
- filling the result array with `push` instead of `new Array(n)` before sorting: 35 % faster in a micro-benchmark sorting 20,000 results, unchanged on the library;
- the earlier fixed-shape options and parameters (`08892a5`): same times as master.

The gap is not in the index forms or the result shapes: it is in the new compiler's handling of `Map` and of `Array.prototype.sort`. Other patterns behave erratically: `a[(offset + i) | 0]` is 4x slower than `a[offset + i]` under `--aot`, and `a[b[i] % a.length]` (an index that is `NaN` when `a` is empty) is 7.6x slower than under `--no-aot`, reported with the same `loose-type` label as in #48239 (this library has no such index). No code change is kept from this round; re-measure with the next canaries.

The `--explain` entries name the base of each access (`docIds`, `fieldLengthMatrix`, `states`), not its index. Those bases are typed-array views created over the snapshot buffer, or arrays carried inside objects passed across calls. One trigger explains most of them:

```ts
function make(buf: ArrayBufferLike): Uint32Array { return new Uint32Array(buf, 0, 2) }
function sum(a: Uint32Array): number { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t }
console.log(sum(make(new ArrayBuffer(8))))
```

`--explain` reports `a` in `sum` as `unknown-object` / `loose-type`. With `make(): Uint32Array { return new Uint32Array(8) }` (no buffer parameter) the same `sum` is typed; and `new Uint32Array(buf, 0, 2)` read inside the function that receives `buf` is typed too. The view becomes untyped only once it crosses a non-inlined call. Exporting the function prevents inlining and makes the same one-access body untyped. Allocating the typed array by length and filling it keeps the tracking downstream (only the read from the tainted source is flagged), but it copies each postings and matrix column and adds its memory; not worth it on an experimental compiler. The docs say an access is typed "from your types or by tracking the object from where it's created"; here the type is declared and the object is created locally, so this is a compiler gap to report, separate from #48239 (which is about how the entry is labelled).

The 2,704 entries follow from this: posting and field-length arrays are views over the snapshot buffer, and the fuzzy state array travels inside the `BitSearch` object passed to `visitBits` and `visitLeafAtRow`. No rewrite of an index expression can clear them, which matches the measurements above. They also explain only part of the finalization cost: the standalone benchmark feeds `finalizeSearchResults` a fully typed `Map` and is still 2.3x slower than before, so the missing backend specialization matters too.

### Speed before the rewrite (`da867c60b` / `1.4.4`, µs/op unless noted)

| Metric | Node 24 | Bun JIT | compile `--no-aot` | compile `--aot` | `--aot` vs `--no-aot` |
|--------|--------:|--------:|-------------------:|----------------:|----------------------:|
| build (ms) | 276 | 336 | 314 | 211 | -33 % |
| save+load (ms) | 512 | 298 | 283 | 219 | -23 % |
| exact | 33.7 | 44.6 | 38.7 | 28.7 | -26 % |
| prefix | 210 | 232 | 173 | 186 | ~ |
| fuzzy | 59.6 | 48.7 | 48.0 | 54.7 | ~ |
| multi-term OR | 10,231 | 13,131 | 14,040 | 10,977 | -22 % |
| multi-term AND | 155 | 191 | 288 | 121 | -58 % |
| autoSuggest | 237 | 370 | 412 | 159 | -61 % |
| searchPage | 91 | 152 | 130 | 48 | -63 % |

With the exact-suffix tail shortcut in `PackedRadixTree.fuzzy` (`walkExactSuffix`), fuzzy searches avoid ~79% of Levenshtein DP cell evaluations and ~86% of recursive edge explorations once `minDistance === maxDistance`, bringing fuzzy search execution down from ~80 µs to ~55 µs in AOT (and from ~0.35 ms to ~0.13 ms, >2.5x faster, on realistic vocabularies like the 23k terms BDPM index). Result counts were identical with and without AOT on all queries compared.

### Size (`1.4.5-canary.1+9990f3d48` and `1.4.4-canary.1+8aa496e1d`, MiB on disk unless noted)

| Artifact | `8aa496e1d` | `9990f3d48` |
|----------|------------:|------------:|
| hello world, `--aot` | 66.9 MiB | 65.7 MiB |
| hello world, `--aot --trim` | 24.5 MiB | 24.6 MiB |
| hello world + `node:zlib`, `--aot --trim` | 38.4 MiB | 38.6 MiB |
| hello world, `--no-aot` | 148.1 MiB | 150.0 MiB |
| benchmark / consumer executable, `--aot` | 70.2 MiB | 69.4 MiB |
| benchmark / consumer executable, `--aot --trim` | 39.7 MiB | 40.4 MiB |
| benchmark / consumer executable, `--no-aot` | 148.3 MiB | 150.2 MiB |
| `dist/aot/index.aot.ts` | 249 KB | 250 KB |

Before the rewrite, the library added roughly 2 MB to an AOT executable (`da867c60b`: 68 MB hello, 70 MB benchmark, 140 MB `--no-aot`). With `2596ac5d3`, hello world was 65 MB (`--aot`) and 134 MB (`--no-aot`), while the benchmark executable swelled to 114 MB with `--aot`. On `8aa496e1d`, the benchmark executable dropped back to 70.2 MiB (`39.7 MiB` with `--trim`), and on `9990f3d48` (consumer of `1.13.0`) it is `69.4 MiB` (`40.4 MiB` with `--trim`).

### Memory (RSS, MiB, after forced GC)

On `1.4.4-canary.1+8aa496e1d` (Divina Commedia x3, 200,000 queries across 8 terms, 2 runs each):

| Phase | Bun JIT | `--no-aot` | `--aot` |
|-------|--------:|-----------:|--------:|
| index loaded | 102–107 | 105.6–109.7 | **72.4–72.5** |
| steady state, 50k–200k queries | 97.4–103.0 | 98.0–104.8 | **69.7–71.6** |
| peak between GCs, steady state | 156.2–162.7 | 158.3–161.3 | **103.3–104.1** |

No leak up to 200,000 queries in any configuration. Unlike before the rewrite (when `--aot` had a lower resting RSS of 82–85 MB vs 96–104 MB, but a higher peak between GCs of 148–155 MB vs 120–135 MB), `--aot` on `8aa496e1d` is ~30–35 % lower in **both** steady state and peak RSS between GCs.

## Code changes made for AOT

Only changes that are neutral or better under Node and Bun JIT are kept:

- the stream type derived from `node:zlib` (above), originally required so the AOT source was not compiled without its types;
- `visitRecurse` in `fuzzyMatrix.ts` takes its invariant state in one object, like the bit-parallel walk;
- `decodeMsv5PostingsSections` takes the wire object that the encoder builds;
- JSON snapshot validation checks `typeof` before narrowing instead of casting.

Workarounds for compiler limits that the rewrite already changed (spreads replaced by hand-written fixed-shape objects, callbacks grouped into objects to stay under 8 arguments, `map`/`reduce` replaced by loops, union types for `Set` gates) were dropped. The fixed-shape option merge also changed behaviour: an option passed explicitly as `undefined` or `null` no longer overrode the index-level `searchOptions`, unlike MiniSearch (`dev/parity/functional-parity.test.js` now covers it).

## Bun issues found along the way

All seven issues are still open on GitHub. Statuses below come from re-running each issue's own repro on `1.4.6-canary.1+736fe1187` (static reports and sizes; #48283 needs timings and keeps its last measured status). The last column says what to do if the issue is still open when the library is released.

| Issue | Status on `736fe1187` | Effect on this library | Mitigation at release |
|-------|-----------------------|------------------------|-----------------------|
| [#47764](https://github.com/oven-sh/bun/issues/47764) arguments past the 8th not tracked | No longer reproduces: `args8` and `args9` give the same report (`2 direct, 1 indirect`). | None: the library no longer relies on staying under eight arguments. | None needed. |
| [#47919](https://github.com/oven-sh/bun/issues/47919) `--trim-without=<name>` rejects names | Partly fixed: PascalCase names (`Profilers`, `Fetch`) work; the lowercase tags printed by `--explain=trim` still fail; the flag is still missing from `--help`. | None (consumer build flag). | Document `--trim` / `--trim-locales` (above). |
| [#47920](https://github.com/oven-sh/bun/issues/47920) `node:zlib` blocks `--trim` | Still reproduces on size: trimmed hello world 24.18 MiB, `Bun.hash.crc32` 24.23 MiB, `node:zlib` `crc32` 38.56 MiB, with `locales: all`. `--explain=trim` now sees every API. | Size only: about +14 MiB for any trimmed consumer, since the Node entry imports `node:zlib` statically. | Accept and document. Moving compression behind a dynamic import would break the sync API and make the AOT source differ from the Node one. |
| [#48144](https://github.com/oven-sh/bun/issues/48144) false `property-added` with `extends` | No longer reproduces: `Every property access is typed`. | None. | None needed. |
| [#48145](https://github.com/oven-sh/bun/issues/48145) `node:zlib` `crc32` not a direct call | Still reproduces (`unknown-callee`). | Binary I/O only: one indirect call per checksummed section. | Accept. No `Bun.hash` in `src/`, so Node and AOT share one source. |
| [#48239](https://github.com/oven-sh/bun/issues/48239) index that may be `undefined` labelled `loose-type` | Fixed: `from-array.ts` is fully typed; `total-items.ts` says the element may be missing. | Report wording only. | None needed. |
| [#48283](https://github.com/oven-sh/bun/issues/48283) `Map`/`Set` iteration, `Map.get` and array reads slower since the rewrite | Last measured on `ed4363334`: recovered in microbenchmarks, `map.get` with an `Int32Array` key at parity. Not re-timed. | Hot path (result finalization, scoring). | `matchInfo: false` where match details are not needed; `--no-aot` as a fallback. On the `25c4fca9e` suite, typed AOT beat `--no-aot` or stayed within 4 % of it at every median. |

Earlier re-tests:

| Issue | Status with `2596ac5d3` | Status with `8aa496e1d` | Status with `1.4.5-canary.1` |
|-------|-------------------------|-------------------------|------------------------------|
| [#47764](https://github.com/oven-sh/bun/issues/47764) arguments past the 8th not tracked | No longer reproduces: the 8- and 9-argument variants give the same report. | Still fixed (identical `--explain` on `args8`, `args9`, `args9first`). | — (not re-tested) |
| [#47919](https://github.com/oven-sh/bun/issues/47919) `--trim-without=<name>` rejects every name | Still reproduces (the flag is no longer listed in `--help`). | Parser fixed for PascalCase feature names (e.g. `Fetch`, `Profilers`, `Sqlite`; lowercase `--explain=trim` tags like `profiler` / `fetch` trigger `Did you mean "Profilers"?` / `"Fetch"?`). Flag still omitted from `--help`. | Same (`ed4363334`: `Fetch` accepted, flag still omitted from `--help`). |
| [#47920](https://github.com/oven-sh/bun/issues/47920) `node:zlib` blocks `--trim` | Partly fixed: the compiler now sees every API, but a `node:zlib` import still doubles a trimmed hello world (25 → 53 MB), as in [#48182](https://github.com/oven-sh/bun/issues/48182). | Improved (`24.5 → 38.4 MiB`, still +14 MiB over `Bun.hash.crc32` / bare hello; keeps `locales: all` via `BigInt.prototype.toLocaleString`, `profiler`, etc.). | Same (`9990f3d48`: `24.6 → 38.6 MiB`, still `+14 MiB`). |
| [#48144](https://github.com/oven-sh/bun/issues/48144) false `property-added` with `extends` | No longer reproduces; the same program now reports an `unknown-callee` at the subclass. | **Fixed**: `repro_subclass.ts` reports `Every property access is typed. Nothing to fix.` | — (not re-tested) |
| [#48145](https://github.com/oven-sh/bun/issues/48145) `node:zlib` `crc32` not a direct call | Confirmed by Bun, now reported as `unknown-callee`; fix in progress (oven-sh/WebKit#1011). | Still reproduces (`unknown-callee` for both `zlib.crc32` and named `crc32`). | Still reproduces (`9990f3d48` for `zlib.crc32`; `ed4363334` for both). |
| [#48239](https://github.com/oven-sh/bun/issues/48239) index that may be `undefined` labelled `loose-type` | Filed against `2596ac5d3`. | **Fixed**: `from-array.ts` is 100 % typed (`3 free`), and `total-items.ts` reports `unknown-object` (`element may be missing` wording, `2 tested, 0 by name`), with no `loose-type` or `lost-track`. | — (not re-tested) |
| [#48283](https://github.com/oven-sh/bun/issues/48283) `Map`/`Set` iteration, `Map.get` and array reads 2-4x slower since the rewrite | Filed against `2596ac5d3`, with a single-file repro compared to `7ca0042d3`. | **Largely recovered**: exact `repro.ts` now beats `--no-aot` (`map-iter` 22.7 vs 130.8 ms, `map-get` 24.5 vs 43.7 ms, `set-iter` 19.2 vs 28.3 ms); only `map.get(keys[i])` with an `Int32Array` key remains slower than `--no-aot` (183.2 vs 126.5 ms). | **Recovered in microbenchmark** (`ed4363334`, `taskset -c 0`): `map.get(keys[i])` with `Int32Array` key reaches parity (`76.8` vs `77.1 ms`), while `map-iter`, `set-iter`, `obj-create`, `sort` and `finalize` stay faster than `--no-aot`. |

## Caveats

- Bun canary feature, flags may change.
- Single corpus, single machine.
