# Compiling with Bun `--aot` (experimental)

Bun can compile TypeScript/JavaScript to machine code at build time. This note explains how to try it with FrozenMiniSearch and what we measured. It applies to **standalone Bun executables** only: Node, browsers and Bun without `--aot` keep using the Rollup bundles.

Tested with `1.4.4-canary.1+da867c60b`, `1.4.4`, `1.4.4-canary.1+7ca0042d3` and `1.4.4-canary.1+2596ac5d3`. The last one is the merge of [oven-sh/bun#47942](https://github.com/oven-sh/bun/pull/47942), which rewrote the compiler: flags, `--explain` output and performance all changed (see [Measurements](#measurements)). The one before it is the last canary with the old compiler and the baseline for the before/after numbers. Bun `1.4.4` stable has no `--aot` at all, so it cannot serve as that baseline.

## Commands

| Command | Effect |
|---------|--------|
| `bun --aot app.ts` | Type-checks like `bun compile`, then runs with built-in objects read-only. **No speed-up.** Useful as a guard. |
| `bun build --compile --aot app.ts --outfile app` (or `bun compile app.ts`) | Real AOT: standalone executable with machine code. |
| `bun build --compile --no-aot app.ts --outfile app` | Classic bundle + JIT executable (baseline). |
| `bun compile app.ts --outfile app --explain` | Lists the slow paths, worst first. `--explain=json` lists all of them; `allocations`, `guards` and `trim` are other reports. |
| `bun check --aot --explain app.ts` | The same report without building. |
| `bun test --aot src/ dev/parity/` | Compiles the tests and the code they import, then runs them. |
| `bun check --no-script` | Type check. AOT needs a type-correct program. |

`bun --aot-log-type-mismatches` and `--explain=missed-optimizations` no longer exist since the rewrite. Before it, the first one found two declared-type mismatches in this repo (fixed in `src/frozenBuild.ts` and `src/scoring.ts`).

`bun test --aot` passes the whole suite except one test: a `vi.spyOn` (imported from `vitest`) on a function that another module imports. Bun only sees such a spy at build time when it is written `spyOn` or `jest.spyOn`/`vi.spyOn` from `bun:test`. The test still passes under Vitest and plain `bun test`.

## Distributing the library

AOT code lives in the **executable**, not in a package. What a package can ship is its typed source behind an `"aot"` export condition, which `bun build --compile --aot` selects by itself (no `--conditions` flag). Without the types, the compiler takes slow paths through the plain JavaScript bundle.

The package does this:

- `make build` runs `scripts/build-aot-source.cjs`, which calls `bun compile --library src/index.ts` and keeps only its `index.aot.ts`, written to `dist/aot/index.aot.ts` (about 250 KB) with the Bun version in its header. The `index.js`, `.d.ts` files and `package.json` that `--library` also emits are dropped: Rollup and the root `package.json` already provide them. Only the Node entry has an AOT source; `./browser` has none.
- `package.json` lists `"aot": "./dist/aot/index.aot.ts"` first in the `.` export, because resolvers take the first matching condition. `scripts/verify-npm-pack.cjs` checks this order and that every export target is in the tarball; `scripts/assert-public-bundles.cjs` scans the file like the other bundles.
- `make test-aot` (`dev/aot/run.mjs`) packs the build, installs it outside the repository and compiles `dev/aot/consumer.ts` with `--aot`. It fails if Bun reports a type error in `index.aot.ts`, if the build did not resolve the `"aot"` condition, or if the executable's results differ from the same consumer under Bun JIT (`dist/es`), bit for bit, across `fromDocuments`, the builder, `fromJSON` and every binary compression. CI runs it on Bun `latest` and `canary`, and `prepublishOnly` runs it before every release.

Bun reports type errors inside a dependency only when a build has other diagnostics, and then compiles the whole package without its types, which still works but runs slower. `make test-aot` therefore also compiles a probe with a deliberate type error. Inside `node_modules`, Bun's checker rejects `node:stream` classes such as `Transform` as types (TS2709) while `bun check` in the repository accepts them, so derive stream types from `node:zlib` instead. Bun checks the AOT source under the `compilerOptions` of the package's `package.json`, or as `strict` when there are none (our case, and `tsconfig.json` is strict too).

Before the rewrite, with the same consumer compiled with `--aot` on the Divina Commedia x3, the `"aot"` condition made exact, prefix and fuzzy search, `AND`, `autoSuggest` and `searchPage` 1.8-2.8x faster than the plain JavaScript bundle. With `2596ac5d3` the gain is 0-25 % (see below). Results are identical in both cases. Against Node, ids and ordering are identical; some scores differ in the last bit (relative difference up to 5e-16), as they already do between Bun JIT and Node (JavaScriptCore and V8 math functions).

## Measurements

Setup: Divina Commedia corpus x3 (42,291 documents, one `txt` field), `fromDocuments`, then `saveBinarySync` / `loadBinarySync` (1.7 MB), queries on the reloaded index. Median of 5 process runs, each metric being the best of 5 passes. One machine, no CPU isolation: expect 10-20 % noise. Scripts were scratch files, not committed.

### Speed with `1.4.4-canary.1+2596ac5d3` (µs/op unless noted)

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

### Size

| Artifact | Size |
|----------|-----:|
| hello world, `--aot` | 68 MB |
| hello world, `--no-aot` | 140 MB |
| benchmark executable (lib + script), `--aot` | 70 MB |
| `dist/es/index.js` | 237 KB |

Before the rewrite, the library added roughly 2 MB to an AOT executable; the Bun runtime is most of the weight. With `2596ac5d3`, hello world is 65 MB (`--aot`) and 134 MB (`--no-aot`), but the benchmark executable is 114 MB with `--aot`.

### Memory (RSS, MB, after forced GC, before the rewrite)

| Phase | Bun JIT | `--no-aot` | `--aot` |
|-------|--------:|-----------:|--------:|
| index loaded | 64 | 63-64 | 61 |
| steady state, 50k-200k queries | 99-104 | 96-99 | **82-85** |
| peak between GCs, steady state | 120-135 | 120-125 | **148-155** |

No leak up to 200,000 queries in any configuration (two runs each). AOT has a lower resting RSS but a **higher peak between GCs**: size container limits on the peak, not on the post-GC value. Cause not investigated (`--explain` reports many heap allocations in the query path).

## Code changes made for AOT

Only changes that are neutral or better under Node and Bun JIT are kept:

- the stream type derived from `node:zlib` (above), without which the AOT source is compiled without its types;
- `visitRecurse` in `fuzzyMatrix.ts` takes its invariant state in one object, like the bit-parallel walk;
- `decodeMsv5PostingsSections` takes the wire object that the encoder builds;
- JSON snapshot validation checks `typeof` before narrowing instead of casting.

Workarounds for compiler limits that the rewrite already changed (spreads replaced by hand-written fixed-shape objects, callbacks grouped into objects to stay under 8 arguments, `map`/`reduce` replaced by loops, union types for `Set` gates) were dropped. The fixed-shape option merge also changed behaviour: an option passed explicitly as `undefined` or `null` no longer overrode the index-level `searchOptions`, unlike MiniSearch (`dev/parity/functional-parity.test.js` now covers it).

## Bun issues found along the way

| Issue | Status with `2596ac5d3` |
|-------|-------------------------|
| [#47764](https://github.com/oven-sh/bun/issues/47764) arguments past the 8th not tracked | No longer reproduces: the 8- and 9-argument variants give the same report. |
| [#47919](https://github.com/oven-sh/bun/issues/47919) `--trim-without=<name>` rejects every name | Still reproduces (the flag is no longer listed in `--help`). |
| [#47920](https://github.com/oven-sh/bun/issues/47920) `node:zlib` blocks `--trim` | Partly fixed: the compiler now sees every API, but a `node:zlib` import still doubles a trimmed hello world (25 → 53 MB), as in [#48182](https://github.com/oven-sh/bun/issues/48182). |
| [#48144](https://github.com/oven-sh/bun/issues/48144) false `property-added` with `extends` | No longer reproduces; the same program now reports an `unknown-callee` at the subclass. |
| [#48145](https://github.com/oven-sh/bun/issues/48145) `node:zlib` `crc32` not a direct call | Confirmed by Bun, now reported as `unknown-callee`; fix in progress (oven-sh/WebKit#1011). |
| [#48239](https://github.com/oven-sh/bun/issues/48239) index that may be `undefined` labelled `loose-type` | Filed against `2596ac5d3`. |
| [#48283](https://github.com/oven-sh/bun/issues/48283) `Map`/`Set` iteration, `Map.get` and array reads 2-4x slower since the rewrite | Filed against `2596ac5d3`, with a single-file repro compared to `7ca0042d3`. |

## Caveats

- Bun canary feature, flags may change.
- Single corpus, single machine.
