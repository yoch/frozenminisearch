# FrozenMiniSearch benchmarks

Reproducible memory and CPU measurements for regression tracking.

## Commands

| Command | Description |
|---------|-------------|
| `yarn benchmark:compare` | Human-readable terminal report (7 scenarios) |
| `yarn benchmark:record` | Run suite → `baselines/latest.json` |
| `yarn benchmark:diff` | Current run vs `baselines/reference.json` (warn/fail thresholds) |
| `yarn benchmark:diff --latest` | `latest.json` vs `reference.json` (no re-run) |
| `yarn benchmark:baseline:update` | `record` + copy to `reference.json` |

Always run with GC exposed:

```bash
NODE_ENV=production node --expose-gc benchmarks/compare.js
```

`yarn benchmark:*` scripts run `yarn build` then `node --expose-gc` automatically.

## Multi-run (optional)

Reduce variance with `--runs N`:

```bash
yarn benchmark:compare --runs 3
yarn benchmark:record --runs 3
yarn benchmark:diff --runs 3
```

Metrics are aggregated with the **median** per scenario.
`--runs` is ignored for `benchmark:diff --latest` (no re-run).

## What to watch when optimizing FrozenMiniSearch

When implementing changes from [README — suggested optimizations](../README.md#suggested-follow-ups-not-implemented-yet), compare at least:

- `indexing.freezeMs`, `indexing.saveBinaryMs`, `loadMs.binary`
- `heapMb.frozen`, `heapMb.frozenVsMutableSavingPct`
- Search p50/p95 on prefix and fuzzy scenarios (noisy; use median over `--runs 3`)

Update `baselines/reference.json` only after intentional wins: `yarn benchmark:baseline:update`.

## Files

- `benchmarkSuite.js` — shared metrics JSON
- `benchmarkScenarios.js` — extreme synthetic corpora
- `baselines/reference.json` — **versioned golden** baseline
- `baselines/latest.json` — last local run (gitignored)

## Optimization workflow

1. Change code
2. `yarn benchmark:diff` — catch regressions vs reference
3. If gains are intentional: `yarn benchmark:baseline:update` and commit `reference.json`

## Recorded metrics (per scenario)

- Isolated heap: mutable, frozen, loadJSON, loadBinary
- Build heap: `addAll` + `freeze` vs `fromDocuments`
- Indexing time: addAll, freeze, fromDocuments, saveBinary
- Disk size: JSON vs MSv3 binary
- `memoryBreakdown`: typed postings, radix tree, stored fields
- Search: p50/p95 per query
- `scoreDrift`: mutable vs frozen score delta on **overflow frequencies** (>255 occurrences of the same term)

## `benchmark:diff` thresholds (regression)

**Fail (exit code 1)** — structural metrics:

- Frozen heap: +10%
- Heap saving % vs mutable: −10 points
- loadBinary: +20%

**Warning only** — search p50 (noisy across runs). Add `--strict` to treat search regressions as failures.

Comparing two local captures (`latest` vs `reference` from different moments) may show search warns without a real regression.
