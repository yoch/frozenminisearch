# Compiling with Bun `--aot` (experimental)

Bun canary (tested: `1.4.4-canary.1+da867c60b`) can compile TypeScript/JavaScript to machine code at build time. This note explains how to try it with FrozenMiniSearch and what we measured. It applies to **standalone Bun executables** only: it has no effect on the npm package consumed from Node or browsers.

## Commands

| Command | Effect |
|---------|--------|
| `bun --aot app.ts` | Type-checks like `bun compile`, then runs with built-in objects read-only. **No speed-up.** Useful as a guard. |
| `bun build --compile --aot app.ts --outfile app` | Real AOT: standalone executable with machine code. |
| `bun build --compile --no-aot app.ts --outfile app` | Classic bundle + JIT executable (baseline). |
| `bun --aot-log-type-mismatches app.ts` | Logs every value that does not match its declared type. |
| `bun build --compile --aot --explain=missed-optimizations app.ts --outfile app` | Reports slow paths (not-inlined calls, heap allocations, unhoisted guards). |
| `bun check --no-script` | Type check. AOT needs a type-correct program. |

`--aot-log-type-mismatches` found two declared-type mismatches in this repo (fixed in `src/frozenBuild.ts` and `src/scoring.ts`). It is worth re-running when touching typed hot paths.

## Distributing the library

AOT code lives in the **executable**, not in a package. For libraries, Bun offers `bun compile --library src/index.ts --outdir out`, which emits plain `index.js`, `.d.ts` files and an `index.aot.ts` typed source, plus a `package.json` with an `"aot"` export condition. A consumer compiling with `--aot` can then compile the library with its types; every other consumer keeps using `index.js`. We only verified the generated output (no native files), not a consumer build, and the repository still ships its Rollup bundles.

## Measurements

Setup: Divina Commedia corpus x3 (42,291 documents, one `txt` field), `fromDocuments`, then `saveBinarySync` / `loadBinarySync` (1.7 MB), queries on the reloaded index. Median of 5 process runs, each metric being the best of 5 passes. One machine, no CPU isolation: expect 10-20 % noise. Scripts were scratch files, not committed.

### Speed (µs/op unless noted)

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

The library adds roughly 2 MB to an AOT executable; the Bun runtime is most of the weight.

### Memory (RSS, MB, after forced GC)

| Phase | Bun JIT | `--no-aot` | `--aot` |
|-------|--------:|-----------:|--------:|
| index loaded | 64 | 63-64 | 61 |
| steady state, 50k-200k queries | 99-104 | 96-99 | **82-85** |
| peak between GCs, steady state | 120-135 | 120-125 | **148-155** |

No leak up to 200,000 queries in any configuration (two runs each). AOT has a lower resting RSS but a **higher peak between GCs**: size container limits on the peak, not on the post-GC value. Cause not investigated (`--explain` reports many heap allocations in the query path).

## Caveats

- Bun canary feature, flags may change.
- Single corpus, single machine.
- The full test suite was not run under `--aot`; only `bun check` and the regular vitest suite on the committed code.
