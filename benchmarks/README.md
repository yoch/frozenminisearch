# Benchmarks — `@yoch/frozenminisearch`

Modular harness under `benchmarks/framework/` with three **profiles**:

| Profile | CLI flag | Purpose |
|---------|----------|---------|
| `vs-reference` | `--profile=vs-reference` | Compare frozen vs lucaong `minisearch` (memory, build, search, migrate, drift) |
| `regression` | `--profile=regression` (default) | Full suite vs committed baselines |
| `dev` | `--profile=dev` or `--quick` | Fast search-only smoke (1 run × 10 iterations) |

## Commands

```bash
npm run bench                              # regression run
npm run bench -- run --profile=vs-reference
npm run bench -- run --profile=dev --quick
npm run bench:record                       # capture baseline
npm run bench:diff                         # diff vs baseline
npm run bench:history                      # history analysis
npm run bench:micro                        # Benchmark.js micro suites (Divina corpus)
npm run bench -- micro --only=fuzzy,ranking
npm run bench:micro -- --list
```

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

Corpus fixture: `benchmarks/divinaCommedia.js` (lucaong `minisearch`). Suite modules live alongside under `benchmarks/*.js`; registry in `benchmarks/micro/registry.mjs`.

### Search timing protocol (v2)

- Calibration: `npm run benchmark:calibrate-batches` → `searchBenchBatches.json` (target **3 ms** per sample, batch up to **256**)
- Runtime: **paired** samples (mutable block then frozen block per iteration), `process.hrtime.bigint()`
- Iterations: **20** default, **50** when probe p50 &lt; 0.1 ms
- Sub-0.1 ms baselines: report **µs** deltas in `compare.js` (not misleading %)
- Recalibrate after corpus/query changes; diff warns on Node / minisearch version mismatch (non-blocking)

## Surfaces

Activate with `--surfaces=build,search,save,load,memory,migrate,drift` or `all`.

| Surface | Measures |
|---------|----------|
| `build` | `fromDocuments` / `fromMiniSearch` vs mutable `addAll` |
| `search` | Paired mutable/frozen `search()` timing (`hrtime`, see `searchBenchBatches.json`) |
| `search-levels` | L0 lookup / L1 `executeQuery` / L2 `search` decomposition |
| `save` / `load` | MSv5 round-trip |
| `memory` | `memoryBreakdown` + heap estimates |
| `migrate` | JSON → frozen path |
| `drift` | Score drift vs reference (`toBeCloseTo` tolerance) |

## Core modules

| Module | Role |
|--------|------|
| `benchmarks/framework/cli.mjs` | Unified CLI (`run`, `record`, `diff`, `history`) — sets `BENCH_SURFACES` |
| `benchmarks/framework/surfaces.mjs` | Surface list + defaults per profile |
| `benchmarks/benchmarkSuite.js` | Core scenarios (shared by compare/capture) |

Legacy `benchmarks/index.js` orchestrator was replaced by `npm run bench:micro`.

## Baselines

Committed reference: `benchmarks/baselines/reference.json` (protocol **v2**, paired hrtime).

```bash
npm run bench:reference:update   # RUNS=3 vs-reference → reference.json + README table
npm run bench:readme               # regenerate README comparison only
```

Legacy: `npm run benchmark:baseline:update` (re-runs with default regression surfaces).
