# Benchmarks — `@yoch/frozenminisearch`

Modular harness under `benchmarks/framework/` with three **profiles**:

| Profile | CLI flag | Purpose |
|---------|----------|---------|
| `vs-reference` | `--profile=vs-reference` | Compare frozen vs MiniSearch (memory, build, search, migrate, drift) |
| `regression` | `--profile=regression` (default) | Full suite vs committed baselines |
| `dev` | `--profile=dev` or `--quick` | Fast search-only smoke (1 run × 10 iterations) |

## Commands

```bash
pnpm bench                              # regression run
pnpm bench -- run --profile=vs-reference
pnpm bench -- run --profile=dev --quick
pnpm bench:record                       # capture baseline
pnpm bench:diff                         # diff vs baseline
pnpm bench:history                      # history analysis
pnpm bench:micro                        # Benchmark.js micro suites (Divina corpus)
pnpm bench -- micro --only=fuzzy,ranking
pnpm bench:micro -- --list
pnpm bench:build-peak                   # transient heap peak during FrozenIndexBuilder
pnpm bench:memory                       # isolated heap phase only (protocol v3)
pnpm bench:medicaments-build-peak       # rebuild peak from corpus extracted out of .msbin fixtures
```

`bench:build-peak` writes `benchmarks/baselines/build-peak-heap.json` (peak vs retained heap, radix share estimate).

`bench:medicaments-build-peak` measures `FrozenIndexBuilder` peak on real post-parse JSONL when available (`/home/yoch/fr.gouv.medicaments.rest/data/corpus-export`, override with `CORPUS_EXPORT_DIR`). Documents contain **indexed fields + `id` only** (`buildIndexDocument`). Fallback: invert `.msbin` fixtures (`SOURCE=msbin`). Output: `medicaments-build-peak-heap.json` (jsonl) or `medicaments-build-peak-heap-msbin.json`. Filter: `ONLY=bdpm-presentations`.

**Dev** : préférer `pnpm test` + `ONLY=bdpm-presentations pnpm run bench:medicaments-build-peak`. Réserver `benchmark:diff:run` (suite complète, long) à la CI / pré-merge.

`bench:build-heap-profile` — profil rapide add vs freeze (réel vs synthétique few-terms / 1-field) → `benchmarks/baselines/build-heap-profile.json`.

## Micro-benchmarks (`benchmarks/micro/`)

Fast **ops/sec** probes on the Divine Commedia corpus via [Benchmark.js](https://www.npmjs.com/package/benchmark) — separate from the regression harness (`benchmarkSuite.js`).

| Suite id | What it measures |
|----------|------------------|
| `exact` | `SearchableMap#get` |
| `prefix` | `SearchableMap#atPrefix` |
| `fuzzy` | `SearchableMap#fuzzyGet` (distances 1–4) |
| `combined` | `MiniSearch#search` fuzzy + prefix |
| `ranking` | `MiniSearch#search` with prefix |
| `filter` | `MiniSearch#search` with filter |
| `autosuggest` | `MiniSearch#autoSuggest` |

Corpus fixture: `benchmarks/divinaCommedia.js` (MiniSearch). Suite modules live alongside under `benchmarks/*.js`; registry in `benchmarks/micro/registry.mjs`.

### Search timing protocol (v2)

- Calibration: `pnpm benchmark:calibrate-batches` → `searchBenchBatches.json` (target **3 ms** per sample, batch up to **256**)
- Runtime: **paired** samples (mutable block then frozen block per iteration), `process.hrtime.bigint()`
- Iterations: **20** default, **50** when probe p50 &lt; 0.1 ms
- Scenario runs: default captures request 3 runs, but very expensive calibrated search scenarios are capped automatically (logged and stored as `benchmarkRuns`); use `BENCH_NO_RUN_CAPS=1` or `--no-run-caps` for decisive full repeats.
- Sub-0.1 ms baselines: report **µs** deltas in `compare.js` (not misleading %)
- Recalibrate after corpus/query changes; diff warns on Node / minisearch version mismatch (non-blocking)

## Surfaces

Activate with `--surfaces=build,search,save,load,memory,migrate,drift` or `all`.

| Surface | Measures |
|---------|----------|
| `build` | `fromDocuments` / `fromMiniSearch` vs mutable `addAll` |
| `search` | Paired mutable/frozen `search()` timing (`hrtime`, see `searchBenchBatches.json`) |
| `search-levels` | L0 lookup / L1 `executeQuery` / L2 `search` decomposition |
| `save` / `load` | binary snapshot round-trip |
| `memory` | Retained heap (protocol **v3**: isolated scenario process, in-process trials, median+MAD) + `memoryBreakdown` |
| `migrate` | JSON → frozen path |
| `drift` | Score drift vs reference (`toBeCloseTo` tolerance) |

## Core modules

| Module | Role |
|--------|------|
| `benchmarks/framework/cli.mjs` | Unified CLI (`run`, `record`, `diff`, `history`) — sets `BENCH_SURFACES` |
| `benchmarks/framework/surfaces.mjs` | Surface list + defaults per profile |
| `benchmarks/benchmarkSuite.js` | Core scenarios (shared by compare/capture) |

Legacy `benchmarks/index.js` orchestrator was replaced by `pnpm bench:micro`.

## Heap protocol v3

CPU/search benchmarks and retained-heap measurement run in **separate processes**:

1. `captureBaseline.js` runs the CPU suite (`memory` / `breakdown` surfaces stripped).
2. `runHeapSuite.mjs` spawns one Node process per allowlisted scenario (`benchmarks/framework/heapScenarios.mjs`).
3. Each scenario process warms up once per path, then runs in-process trials: GC×3 → allocate one index → GC×3 → delta (median+MAD).

Env overrides: `BENCH_HEAP_TRIALS`, `BENCH_HEAP_SCENARIOS`, `BENCH_HEAP_PATHS`, `BENCH_HEAP_GC_PASSES`, `BENCH_HEAP_WARMUP`.

Optional Chrome validation: `node --expose-gc benchmarks/scripts/heap-snapshot-pair.mjs --scenario=divina-indexOnly`.

## Baselines

Committed reference: `benchmarks/baselines/reference.json` (search protocol **v2**, heap protocol **v3**).

```bash
pnpm run bench:reference:update   # RUNS=3 vs-reference → reference.json + README table
pnpm run bench:readme               # regenerate README comparison only
```

Legacy: `pnpm benchmark:baseline:update` (re-runs with default regression surfaces).
