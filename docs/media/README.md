# FrozenMiniSearch benchmarks

Reproducible memory and CPU measurements for regression tracking.

**Commit-by-commit history:** [`perf-history.jsonl`](perf-history.jsonl) + [`scripts/README.md`](scripts/README.md) (record after each commit, analyze frozen vs mutable).

## Commands

| Command | Description |
|---------|-------------|
| `yarn benchmark:compare` | Human-readable report (runs suite; default 3×50 search iters) |
| `yarn benchmark:compare --from baselines/latest.json` | Same report from saved JSON (no re-run) |
| `yarn benchmark:record` | Run suite → `baselines/latest.json` |
| `yarn benchmark:diff` | `latest.json` vs `reference.json` (no re-run) |
| `yarn benchmark:diff:run` | Re-run suite, update `latest.json`, then diff |
| `yarn benchmark:targeted` | Run failure-prone scenarios only → stdout or `--out file.json` |
| `yarn benchmark:targeted:compare` | Compare two targeted captures; fails only if **after** regresses vs **before** |
| `yarn benchmark:baseline:update` | `record` + copy to `reference.json` |
| `benchmarks/scripts/record-history.sh` | Append HEAD → `perf-history.jsonl` (clean tree) |
| `benchmarks/scripts/analyze-history.sh` | Timeline, compare, CHANGELOG snippets, vs mutable |

Always run with GC exposed:

```bash
NODE_ENV=production node --expose-gc benchmarks/compare.js
```

`yarn benchmark:*` scripts run `yarn build` then `node --expose-gc` automatically.

## Defaults (routine)

- **3 runs** per scenario (median aggregation)
- **50 timed searches** per query (`--iterations` to override)
- Override via env: `RUNS=2 SEARCH_ITERATIONS=30 yarn benchmark:record`

`benchmark:diff` does **not** re-run the suite: record once, diff as often as needed.
Compare another capture: `yarn benchmark:diff --current=path/to/run.json`.

Force a fresh measurement: `yarn benchmark:diff:run` (writes `latest.json` then diffs).

## What to watch when optimizing FrozenMiniSearch

When implementing changes from [README — suggested optimizations](../README.md#suggested-follow-ups-not-implemented-yet), compare at least:

- `indexing.freezeMs`, `indexing.saveBinaryMs`, `loadMs.binary`
- `heapMb.frozen`, `heapMb.frozenVsMutableSavingPct`
- Search p50/p95 on prefix and fuzzy scenarios (noisy; use median over `--runs 3`)

Update `baselines/reference.json` only after intentional wins: `yarn benchmark:baseline:update`.

## Files

- `benchmarkSuite.js` — shared metrics JSON (mutable + frozen on each scenario)
- `benchmarkScenarios.js` — extreme synthetic corpora
- `perf-history.jsonl` — **versioned timeline** (one JSON line per clean commit)
- `scripts/` — `record-history`, `analyze-history`, `backfill-history`, post-commit sample
- `baselines/reference.json` — **versioned golden** baseline for `benchmark:diff`
- `baselines/latest.json` — last local run (gitignored)

## Optimization workflow

1. Change code
2. `yarn benchmark:record` then `yarn benchmark:diff` — regressions vs reference
3. Commit; `benchmarks/scripts/record-history.sh` (uses same defaults)
4. `benchmarks/scripts/analyze-history.sh --changelog` — update CHANGELOG if significant
5. If gains are intentional: `yarn benchmark:baseline:update` and commit `reference.json` + `perf-history.jsonl`

## Recorded metrics (per scenario)

- **Frozen vs mutable MiniSearch** on the same corpus: heap, search p50/p95 per query,
  `frozenP50VsMutablePct`, `scoreDrift` on overflow frequencies
- Isolated heap: mutable, frozen, loadJSON, loadBinary
- Build heap: `addAll` + `freeze` vs `fromDocuments`
- Indexing time: addAll, freeze, fromDocuments, saveBinary
- Disk size: JSON vs MSv3/MSv4 binary
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

### Targeted before/after (code change on same commit)

For noisy extreme scenarios, compare two captures without treating stale `reference.json` as the gate:

```bash
# on baseline tree (e.g. git stash / detached HEAD)
yarn benchmark:targeted --label before --out /tmp/targeted-before.json
# on candidate tree
yarn benchmark:targeted --label after --out /tmp/targeted-after.json
yarn benchmark:targeted:compare --compare=/tmp/targeted-before.json,/tmp/targeted-after.json
# optional context only (does not affect exit code):
yarn benchmark:targeted:compare --compare=/tmp/targeted-before.json,/tmp/targeted-after.json --reference=benchmarks/baselines/reference.json
```

Exit code 1 only when **after** is worse than **before** on freeze / saveBinary / loadBinary.

- Baseline ≥ 10 ms: % thresholds from `regressionPolicy.js` (freeze +40 %, saveBinary +30 %, loadBinary +20 %).
- Baseline &lt; 10 ms: **both** absolute (+2 ms warn, +5 ms fail) **and** % cap (+20 % warn, +35 % fail when base ≥ 0.5 ms), since either alone is too loose on tiny timings.

All structural timing rules live in `benchmarks/regressionPolicy.js` (shared by `benchmark:diff` and `benchmark:targeted:compare`).
