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
```

## Surfaces

Activate with `--surfaces=build,search,save,load,memory,migrate,drift` or `all`.

| Surface | Measures |
|---------|----------|
| `build` | `fromDocuments` / `fromMiniSearch` vs mutable `addAll` |
| `search` | Timed search batches (see `searchBenchBatches.json`) |
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

Legacy `benchmarks/index.js` (Benchmark.js) was removed; use `npm run bench` instead.

## Baselines

Committed reference: `benchmarks/baselines/reference.json`. Update with `npm run benchmark:baseline:update` after intentional perf changes.
